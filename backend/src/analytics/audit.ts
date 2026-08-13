/**
 * Audit trail + analytics events (spec §8.6, §14).
 *
 * Audit answers "who changed this safety-relevant thing and when".
 * Events answer "how is the assistant performing".
 */
import { db, toJson, nowIso } from '../db/index.js';

export interface AuditInput {
  entity: 'product' | 'kb' | 'settings' | 'label_draft' | 'escalation';
  entityId: string;
  action: string;
  actor?: string | null;
  detail?: unknown;
}

export function logAudit(input: AuditInput): void {
  db()
    .prepare(
      `INSERT INTO audit_log (entity, entity_id, action, actor, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.entity, input.entityId, input.action, input.actor ?? null, toJson(input.detail ?? null), nowIso());
}

export function auditTrail(entity?: string, entityId?: string, limit = 100) {
  const conn = db();
  const rows =
    entity && entityId
      ? conn
          .prepare(
            `SELECT * FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT ?`,
          )
          .all(entity, entityId, limit)
      : conn.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`).all(limit);
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    entity: String(r.entity),
    entity_id: String(r.entity_id),
    action: String(r.action),
    actor: (r.actor as string) ?? null,
    detail: r.detail_json ? JSON.parse(String(r.detail_json)) : null,
    created_at: String(r.created_at),
  }));
}

/** The KPI event names from spec §14. Kept as a union so typos fail to compile. */
export type EventName =
  | 'session_started'
  | 'questionnaire_started'
  | 'questionnaire_answered'
  | 'recommendation_shown'
  | 'recommendation_view_product'
  | 'recommendation_compare'
  | 'recommendation_add_to_cart'
  | 'recommendation_replace'
  | 'routine_built'
  | 'faq_answered'
  | 'faq_no_answer'
  | 'escalated'
  | 'feedback_up'
  | 'feedback_down'
  | 'turn_completed'
  | 'language_locked';

export function logEvent(name: EventName, sessionId: string | null, payload?: unknown): void {
  db()
    .prepare(`INSERT INTO events (session_id, name, payload_json, created_at) VALUES (?, ?, ?, ?)`)
    .run(sessionId, name, toJson(payload ?? null), nowIso());
}

function countEvent(name: EventName, since: string): number {
  const row = db()
    .prepare(`SELECT COUNT(*) AS c FROM events WHERE name = ? AND created_at >= ?`)
    .get(name, since) as Record<string, unknown>;
  return Number(row.c ?? 0);
}

function distinctSessions(name: EventName, since: string): number {
  const row = db()
    .prepare(`SELECT COUNT(DISTINCT session_id) AS c FROM events WHERE name = ? AND created_at >= ?`)
    .get(name, since) as Record<string, unknown>;
  return Number(row.c ?? 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 10;
}

/** Feeds the admin Analytics dashboard (spec §8.4, §14). */
export function kpiSummary(days = 30) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const conn = db();

  const sessions = distinctSessions('session_started', since);
  const questionnaireStarted = distinctSessions('questionnaire_started', since);
  const reachedRecommendation = distinctSessions('recommendation_shown', since);
  const escalations = distinctSessions('escalated', since);
  const faqAnswered = countEvent('faq_answered', since);
  const faqNoAnswer = countEvent('faq_no_answer', since);
  const up = countEvent('feedback_up', since);
  const down = countEvent('feedback_down', since);

  const downReasons = (
    conn
      .prepare(
        `SELECT reason, COUNT(*) AS c FROM feedback
          WHERE rating = 'down' AND reason IS NOT NULL AND created_at >= ?
          GROUP BY reason ORDER BY c DESC LIMIT 10`,
      )
      .all(since) as Record<string, unknown>[]
  ).map((r) => ({ reason: String(r.reason), count: Number(r.c) }));

  const topRecommended = (
    conn
      .prepare(
        `SELECT json_extract(payload_json, '$.product_id') AS pid, COUNT(*) AS c
           FROM events
          WHERE name = 'recommendation_add_to_cart' AND created_at >= ?
          GROUP BY pid ORDER BY c DESC LIMIT 10`,
      )
      .all(since) as Record<string, unknown>[]
  )
    .filter((r) => r.pid !== null)
    .map((r) => ({ product_id: Number(r.pid), count: Number(r.c) }));

  return {
    window_days: days,
    sessions,
    questionnaire_completion_rate: ratio(reachedRecommendation, questionnaireStarted),
    recommendation_click_through_rate: ratio(
      countEvent('recommendation_view_product', since) + countEvent('recommendation_compare', since),
      countEvent('recommendation_shown', since),
    ),
    add_to_cart_rate: ratio(
      countEvent('recommendation_add_to_cart', since),
      countEvent('recommendation_shown', since),
    ),
    human_handover_rate: ratio(escalations, sessions),
    no_answer_rate: ratio(faqNoAnswer, faqAnswered + faqNoAnswer),
    helpfulness_score: ratio(up, up + down),
    incorrect_answer_reports: down,
    feedback_down_reasons: downReasons,
    top_added_to_cart: topRecommended,
  };
}
