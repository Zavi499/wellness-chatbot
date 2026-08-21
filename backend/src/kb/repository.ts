/**
 * FAQ / policy knowledge base (spec §7).
 *
 * Direct answers, by explicit store-owner decision: whatever an admin writes
 * for both languages goes live immediately, no separate approval click —
 * mirroring the labeling pipeline's direct-verify behavior. The one gate that
 * remains is completeness, not review: an entry missing either language's
 * answer is never served, and the bot uses the exact fallback template
 * (`KB_FALLBACK`) rather than guessing or answering in only one language.
 */
import type { DatabaseSync } from 'node:sqlite';
import { db, nowIso } from '../db/index.js';
import { logAudit } from '../analytics/audit.js';
import { expandQuery, keywordScore } from '../search/normalize.js';
import { embedOne } from '../search/embeddings.js';
import { searchVectors } from '../search/vector.js';
import type { KbEntry, Language } from '../types.js';

/**
 * "Approved" is computed live from completeness, not trusted from the stored
 * column — so a row saved before direct-answer behavior shipped (complete,
 * but still carrying an old `approved = 0`) is correctly treated as usable
 * without needing a data migration.
 */
function isComplete(r: { answer_en?: unknown; answer_ar?: unknown }): boolean {
  return Boolean(r.answer_en) && Boolean(r.answer_ar);
}

function rowToEntry(r: Record<string, unknown>): KbEntry {
  return {
    id: Number(r.id),
    topic: String(r.topic ?? ''),
    question_en: (r.question_en as string) ?? null,
    question_ar: (r.question_ar as string) ?? null,
    answer_en: (r.answer_en as string) ?? null,
    answer_ar: (r.answer_ar as string) ?? null,
    approved: isComplete(r),
    updated_at: String(r.updated_at ?? ''),
    updated_by: (r.updated_by as string) ?? null,
  };
}

export function listKb(includeUnapproved = true, conn: DatabaseSync = db()): KbEntry[] {
  const sql = includeUnapproved
    ? 'SELECT * FROM kb_entries ORDER BY topic'
    : `SELECT * FROM kb_entries
        WHERE answer_en IS NOT NULL AND answer_en <> ''
          AND answer_ar IS NOT NULL AND answer_ar <> ''
       ORDER BY topic`;
  return (conn.prepare(sql).all() as Record<string, unknown>[]).map(rowToEntry);
}

export function getKbEntry(id: number, conn: DatabaseSync = db()): KbEntry | null {
  const row = conn.prepare('SELECT * FROM kb_entries WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToEntry(row) : null;
}

export interface KbUpsert {
  id?: number;
  topic: string;
  question_en?: string | null;
  question_ar?: string | null;
  answer_en?: string | null;
  answer_ar?: string | null;
  actor?: string;
}

/**
 * No `approved` input — whether an entry is usable is derived from whether
 * both languages have an answer, not from a separate manual approval step.
 * An edit to an already-live entry takes effect immediately, the same way.
 */
export function upsertKb(input: KbUpsert, conn: DatabaseSync = db()): KbEntry {
  const approved = isComplete(input) ? 1 : 0;

  if (input.id) {
    conn
      .prepare(
        `UPDATE kb_entries
            SET topic = ?, question_en = ?, question_ar = ?, answer_en = ?, answer_ar = ?,
                approved = ?, updated_at = ?, updated_by = ?
          WHERE id = ?`,
      )
      .run(
        input.topic,
        input.question_en ?? null,
        input.question_ar ?? null,
        input.answer_en ?? null,
        input.answer_ar ?? null,
        approved,
        nowIso(),
        input.actor ?? null,
        input.id,
      );
    logAudit(
      { entity: 'kb', entityId: String(input.id), action: approved ? 'saved_live' : 'saved_incomplete', actor: input.actor },
      conn,
    );
    return getKbEntry(input.id, conn)!;
  }

  const result = conn
    .prepare(
      `INSERT INTO kb_entries (topic, question_en, question_ar, answer_en, answer_ar, approved, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.topic,
      input.question_en ?? null,
      input.question_ar ?? null,
      input.answer_en ?? null,
      input.answer_ar ?? null,
      approved,
      nowIso(),
      input.actor ?? null,
    );
  const id = Number(result.lastInsertRowid);
  logAudit({ entity: 'kb', entityId: String(id), action: 'created', actor: input.actor }, conn);
  return getKbEntry(id, conn)!;
}

export function deleteKb(id: number, actor?: string, conn: DatabaseSync = db()): void {
  conn.prepare('DELETE FROM kb_entries WHERE id = ?').run(id);
  conn.prepare('DELETE FROM embeddings WHERE id = ?').run(`kb:${id}`);
  logAudit({ entity: 'kb', entityId: String(id), action: 'deleted', actor }, conn);
}

/**
 * The exact fallback wording from the source document (spec §7.2). Used
 * verbatim — it is approved copy, not a paraphrase the model may improvise on.
 */
export const KB_FALLBACK: Record<Language, string> = {
  en: 'I do not have verified information about that feature yet, so I do not want to guess. I can connect you with our support team or show you the product page for the latest details.',
  ar: 'لا تتوفر لدي معلومات موثّقة عن هذا الأمر حتى الآن، ولا أريد أن أخمّن. يمكنني توصيلك بفريق الدعم لدينا أو عرض صفحة المنتج للاطلاع على أحدث التفاصيل.',
};

export interface KbMatch {
  entry: KbEntry;
  score: number;
}

/**
 * Retrieves approved KB entries for a topic. Returns an empty array rather than
 * a weak match — the caller must then use `KB_FALLBACK`.
 */
export async function searchKb(topic: string, minScore = 0.35, limit = 3): Promise<KbMatch[]> {
  const approved = listKb(false);
  if (approved.length === 0) return [];

  const expanded = expandQuery(topic);
  const byId = new Map(approved.map((e) => [e.id, e]));

  const scores = new Map<number, number>();
  for (const entry of approved) {
    const haystack = [entry.topic, entry.question_en, entry.question_ar, entry.answer_en, entry.answer_ar]
      .filter(Boolean)
      .join(' ');
    scores.set(entry.id, keywordScore(expanded, haystack));
  }

  try {
    const vector = await embedOne(expanded.normalized || topic);
    for (const hit of searchVectors(vector, { kind: 'kb', limit: 20 })) {
      if (!byId.has(hit.ref_id)) continue; // unapproved entries never surface
      const keyword = scores.get(hit.ref_id) ?? 0;
      scores.set(hit.ref_id, Math.max(keyword, hit.similarity * 0.8 + keyword * 0.2));
    }
  } catch {
    // Embeddings unavailable — keyword scores stand on their own.
  }

  return [...scores.entries()]
    .filter(([, score]) => score >= minScore)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => ({ entry: byId.get(id)!, score }));
}

/** Picks the answer in the customer's language, falling back to the other. */
export function answerIn(entry: KbEntry, language: Language): string | null {
  const primary = language === 'ar' ? entry.answer_ar : entry.answer_en;
  const secondary = language === 'ar' ? entry.answer_en : entry.answer_ar;
  return primary ?? secondary ?? null;
}
