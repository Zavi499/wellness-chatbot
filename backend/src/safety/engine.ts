/**
 * Safety & escalation engine (spec §5).
 *
 * Two entry points:
 *   - `screenMessage` runs before the model on every customer turn.
 *   - `recordEscalation` is also called when the model itself invokes the
 *     `escalate_to_human` tool, so both paths land in the same log.
 *
 * The engine owns the "selling is blocked" flag; nothing else may clear it.
 */
import { db, nowIso, toJson } from '../db/index.js';
import { logEvent, logAudit } from '../analytics/audit.js';
import { handoffOptions } from '../settings/repository.js';
import { detectTriggers, highestUrgency, type TriggerMatch } from './triggers.js';
import { templateFor, SENSITIVE_DATA_WARNING } from './templates.js';
import type { EscalationUrgency, HandoffOptions, Language, SessionState } from '../types.js';

export interface ScreenResult {
  triggered: boolean;
  urgency: EscalationUrgency | null;
  matches: TriggerMatch[];
  /** Approved response text, ready to return without calling the model. */
  message: string | null;
  handoff: HandoffOptions | null;
  /** True once an emergency has fired — selling stops for the whole session. */
  sellingBlocked: boolean;
  /** Set when the customer pasted card/password/ID data. */
  sensitiveDataWarning: string | null;
}

/** Card numbers, long ID numbers, and anything the customer labels a password. */
const CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/;
const CVV_PATTERN = /\bcvv\b[^\d]{0,10}\d{3,4}\b/i;
const PASSWORD_PATTERN = /\b(?:my )?password\b\s*(?:is|:)\s*\S+/i;
const CIVIL_ID_PATTERN = /\b\d{12}\b/; // Kuwaiti Civil ID length

export function containsSensitiveData(message: string): boolean {
  if (CVV_PATTERN.test(message) || PASSWORD_PATTERN.test(message)) return true;
  if (CIVIL_ID_PATTERN.test(message)) return true;
  if (CARD_PATTERN.test(message)) {
    // Avoid flagging ordinary long numbers like an order reference by requiring
    // a card-like grouping or an explicit mention.
    return /\b(card|visa|mastercard|knet|بطاقه|فيزا)\b/i.test(message) || /(?:\d{4}[ -]){3}\d{4}/.test(message);
  }
  return false;
}

/**
 * Runs before every model call. If this returns `triggered`, the orchestrator
 * must short-circuit: return `message` and skip the selling path entirely.
 */
export function screenMessage(session: SessionState, message: string, language: Language): ScreenResult {
  const matches = detectTriggers(message);
  const urgency = highestUrgency(matches);
  const sensitive = containsSensitiveData(message) ? SENSITIVE_DATA_WARNING[language] : null;

  if (!urgency) {
    return {
      triggered: false,
      urgency: null,
      matches: [],
      message: null,
      handoff: null,
      sellingBlocked: session.escalation.selling_blocked,
      sensitiveDataWarning: sensitive,
    };
  }

  const reason = matches.map((m) => m.description).join('; ');
  const summary = summarizeForHandoff(session, message);

  return {
    triggered: true,
    urgency,
    matches,
    message: templateFor(urgency, language),
    handoff: handoffOptions(summary, language),
    sellingBlocked: urgency === 'emergency' || session.escalation.selling_blocked,
    sensitiveDataWarning: sensitive,
  };
}

export interface RecordEscalationInput {
  session: SessionState;
  urgency: EscalationUrgency;
  reason: string;
  source: 'rule' | 'model' | 'questionnaire';
  matchedRule?: string | null;
  language: Language;
}

/** Writes to the Escalation Log so staff can follow up (spec §5.3, §8.3). */
export function recordEscalation(input: RecordEscalationInput): number {
  const transcript = input.session.history.map((t) => ({ role: t.role, content: t.content, at: t.at }));

  const result = db()
    .prepare(
      `INSERT INTO escalations
         (session_id, urgency, reason, trigger_source, matched_rule, transcript_json, language, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(
      input.session.session_id,
      input.urgency,
      input.reason,
      input.source,
      input.matchedRule ?? null,
      toJson(transcript),
      input.language,
      nowIso(),
    );

  const id = Number(result.lastInsertRowid);
  logEvent('escalated', input.session.session_id, {
    urgency: input.urgency,
    reason: input.reason,
    source: input.source,
  });
  logAudit({
    entity: 'escalation',
    entityId: String(id),
    action: 'created',
    actor: `chatbot:${input.source}`,
    detail: { urgency: input.urgency, session_id: input.session.session_id },
  });
  return id;
}

/** A short, non-clinical summary the customer can send on WhatsApp. */
export function summarizeForHandoff(session: SessionState, latestMessage: string): string {
  const answers = Object.entries(session.answers)
    .slice(0, 6)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join('; ');

  const parts = [`Chat reference: ${session.session_id.slice(0, 8)}`];
  if (answers) parts.push(`What I told the assistant — ${answers}`);
  parts.push(`My question: ${latestMessage.slice(0, 300)}`);
  return parts.join('\n');
}

// --- Escalation log queries (admin) -----------------------------------------

export interface EscalationRow {
  id: number;
  session_id: string;
  urgency: EscalationUrgency;
  reason: string;
  trigger_source: string;
  matched_rule: string | null;
  transcript: { role: string; content: string; at: string }[];
  language: string | null;
  status: string;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
}

export function listEscalations(
  opts: { status?: string; urgency?: string; limit?: number; offset?: number } = {},
): EscalationRow[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status) {
    clauses.push('status = ?');
    params.push(opts.status);
  }
  if (opts.urgency) {
    clauses.push('urgency = ?');
    params.push(opts.urgency);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(opts.limit ?? 50, opts.offset ?? 0);

  const rows = db()
    .prepare(`SELECT * FROM escalations ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: Number(r.id),
    session_id: String(r.session_id),
    urgency: String(r.urgency) as EscalationUrgency,
    reason: String(r.reason),
    trigger_source: String(r.trigger_source),
    matched_rule: (r.matched_rule as string) ?? null,
    transcript: JSON.parse(String(r.transcript_json ?? '[]')),
    language: (r.language as string) ?? null,
    status: String(r.status),
    resolution_note: (r.resolution_note as string) ?? null,
    created_at: String(r.created_at),
    resolved_at: (r.resolved_at as string) ?? null,
  }));
}

export function resolveEscalation(id: number, note: string, actor: string): void {
  db()
    .prepare(`UPDATE escalations SET status = 'resolved', resolution_note = ?, resolved_at = ? WHERE id = ?`)
    .run(note, nowIso(), id);
  logAudit({ entity: 'escalation', entityId: String(id), action: 'resolved', actor, detail: { note } });
}
