/**
 * Business settings (spec §8.5).
 *
 * These are the facts marked [TO BE CONFIRMED] in the source blueprint —
 * delivery fees, hours, contact numbers, returns policy. They are read live
 * from this table and are NEVER hardcoded into a prompt. An unfilled field
 * stays empty, and the assistant says it needs to check with a human rather
 * than inventing a value.
 */
import { db, nowIso } from '../db/index.js';
import { logAudit } from '../analytics/audit.js';
import type { BusinessSettings } from '../types.js';

export const SETTING_KEYS = [
  'delivery_areas',
  'delivery_fee',
  'free_delivery_threshold',
  'order_cutoff_time',
  'service_hours',
  'whatsapp_number',
  'phone_number',
  'live_chat_note',
  'payment_methods',
  'loyalty_rules',
  'returns_policy',
  'currency',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export function getSettings(): BusinessSettings {
  const rows = db().prepare('SELECT key, value FROM business_settings').all() as Record<string, unknown>[];
  const map = new Map(rows.map((r) => [String(r.key), (r.value as string) ?? null]));
  const read = (k: SettingKey) => {
    const v = map.get(k);
    return v === undefined || v === '' ? null : v;
  };
  return {
    delivery_areas: read('delivery_areas'),
    delivery_fee: read('delivery_fee'),
    free_delivery_threshold: read('free_delivery_threshold'),
    order_cutoff_time: read('order_cutoff_time'),
    service_hours: read('service_hours'),
    whatsapp_number: read('whatsapp_number'),
    phone_number: read('phone_number'),
    live_chat_note: read('live_chat_note'),
    payment_methods: read('payment_methods'),
    loyalty_rules: read('loyalty_rules'),
    returns_policy: read('returns_policy'),
    currency: read('currency') ?? 'KWD',
  };
}

export function setSettings(patch: Partial<Record<SettingKey, string | null>>, actor?: string): BusinessSettings {
  const conn = db();
  const stmt = conn.prepare(
    `INSERT INTO business_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const changed: string[] = [];
  for (const key of SETTING_KEYS) {
    if (!(key in patch)) continue;
    stmt.run(key, patch[key] ?? null, nowIso());
    changed.push(key);
  }
  if (changed.length) {
    logAudit({ entity: 'settings', entityId: 'business', action: 'updated', actor, detail: { changed } });
  }
  return getSettings();
}

/** Which [TO BE CONFIRMED] facts are still unanswered — drives the launch checklist. */
export function missingSettings(): SettingKey[] {
  const settings = getSettings();
  return SETTING_KEYS.filter((k) => k !== 'currency' && !settings[k]);
}

// --- OpenAI model overrides ---------------------------------------------------
//
// Deliberately not part of BusinessSettings/SETTING_KEYS above: these are
// optional technical overrides, not "facts to confirm" — an unset override
// is not "missing", it just means the OPENAI_MODEL_* env var default applies.
// Stored in the same generic `business_settings` key-value table (no schema
// change needed), read live so a wrong/retired model ID can be fixed from
// the WordPress dashboard without SSH access or a redeploy.

const MODEL_OVERRIDE_DB_KEYS = {
  chat: 'openai_model_chat',
  cheap: 'openai_model_cheap',
  label: 'openai_model_label',
} as const;

export interface ModelOverrides {
  chat: string | null;
  cheap: string | null;
  label: string | null;
}

export function getModelOverrides(): ModelOverrides {
  const dbKeys = Object.values(MODEL_OVERRIDE_DB_KEYS);
  const rows = db()
    .prepare(`SELECT key, value FROM business_settings WHERE key IN (${dbKeys.map(() => '?').join(',')})`)
    .all(...dbKeys) as Record<string, unknown>[];
  const map = new Map(rows.map((r) => [String(r.key), (r.value as string) ?? null]));
  const read = (dbKey: string) => {
    const v = map.get(dbKey);
    return v === undefined || v === '' ? null : v;
  };
  return {
    chat: read(MODEL_OVERRIDE_DB_KEYS.chat),
    cheap: read(MODEL_OVERRIDE_DB_KEYS.cheap),
    label: read(MODEL_OVERRIDE_DB_KEYS.label),
  };
}

export function setModelOverrides(
  patch: Partial<Record<keyof ModelOverrides, string | null>>,
  actor?: string,
): ModelOverrides {
  const conn = db();
  const stmt = conn.prepare(
    `INSERT INTO business_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const changed: string[] = [];
  for (const tier of Object.keys(MODEL_OVERRIDE_DB_KEYS) as (keyof ModelOverrides)[]) {
    if (!(tier in patch)) continue;
    const dbKey = MODEL_OVERRIDE_DB_KEYS[tier];
    const value = patch[tier];
    stmt.run(dbKey, value ? value : null, nowIso());
    changed.push(dbKey);
  }
  if (changed.length) {
    logAudit({ entity: 'settings', entityId: 'openai_models', action: 'updated', actor, detail: { changed } });
  }
  return getModelOverrides();
}
