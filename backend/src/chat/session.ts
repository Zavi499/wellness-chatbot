/**
 * Conversation session store (spec §4.1).
 *
 * Sessions live server-side, keyed by an ID the widget holds in memory only —
 * nothing is written to localStorage, so closing the tab ends the conversation
 * and no chat state follows the customer around the storefront.
 */
import { randomUUID } from 'node:crypto';
import { db, nowIso, parseJson, toJson } from '../db/index.js';
import { config } from '../config.js';
import { logEvent } from '../analytics/audit.js';
import type { AnswerMap, ChatTurn, Language, SessionState } from '../types.js';

function emptyState(sessionId: string): SessionState {
  const now = nowIso();
  return {
    session_id: sessionId,
    language: null,
    language_locked: false,
    created_at: now,
    last_active_at: now,
    answers: {},
    last_recommendations: [],
    history: [],
  };
}

export function createSession(): SessionState {
  const state = emptyState(randomUUID());
  db()
    .prepare(
      `INSERT INTO sessions (session_id, state_json, created_at, last_active_at) VALUES (?, ?, ?, ?)`,
    )
    .run(state.session_id, toJson(state), state.created_at, state.last_active_at);
  logEvent('session_started', state.session_id);
  return state;
}

export function getSession(sessionId: string): SessionState | null {
  const row = db().prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;

  const lastActive = new Date(String(row.last_active_at)).getTime();
  if (Date.now() - lastActive > config.session.ttlMinutes * 60_000) {
    // Expired. Drop it so stale answers cannot leak into a new chat.
    db().prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
    return null;
  }

  return parseJson<SessionState>(row.state_json, emptyState(sessionId));
}

/** Loads an existing session or starts a fresh one. */
export function resumeOrCreate(sessionId?: string | null): SessionState {
  if (sessionId) {
    const existing = getSession(sessionId);
    if (existing) return existing;
  }
  return createSession();
}

export function saveSession(state: SessionState): void {
  state.last_active_at = nowIso();
  db()
    .prepare('UPDATE sessions SET state_json = ?, last_active_at = ? WHERE session_id = ?')
    .run(toJson(state), state.last_active_at, state.session_id);
}

/**
 * Records a questionnaire answer. This is what makes "never ask twice" true —
 * the key is written once and the engine skips any question whose key exists.
 */
export function recordAnswer(state: SessionState, key: string, value: string | string[]): SessionState {
  state.answers[key] = value;
  logEvent('questionnaire_answered', state.session_id, { key, value });
  return state;
}

export function recordAnswers(state: SessionState, answers: AnswerMap): SessionState {
  for (const [k, v] of Object.entries(answers)) recordAnswer(state, k, v);
  return state;
}

export function appendTurn(state: SessionState, role: ChatTurn['role'], content: string): SessionState {
  state.history.push({ role, content, at: nowIso() });
  // Keep the stored transcript bounded; the model gets a window of this anyway.
  if (state.history.length > 60) state.history = state.history.slice(-60);
  return state;
}

export function lockLanguage(state: SessionState, language: Language): SessionState {
  const changed = state.language !== language;
  state.language = language;
  state.language_locked = true;
  if (changed) logEvent('language_locked', state.session_id, { language });
  return state;
}

/** Removes sessions idle past the TTL. Called on an interval by the server. */
export function pruneExpiredSessions(): number {
  const cutoff = new Date(Date.now() - config.session.ttlMinutes * 60_000).toISOString();
  const result = db().prepare('DELETE FROM sessions WHERE last_active_at < ?').run(cutoff);
  return Number(result.changes ?? 0);
}

/** The recent window handed to the model on each call. */
export function recentHistory(state: SessionState, turns = 12): ChatTurn[] {
  return state.history.slice(-turns);
}
