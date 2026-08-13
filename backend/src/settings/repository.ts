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
import type { BusinessSettings, HandoffOptions, Language } from '../types.js';

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

/**
 * Builds the human-handoff options (spec §5.3). Any channel the owner has not
 * configured is simply absent — the widget renders what exists.
 */
export function handoffOptions(summary: string, language: Language): HandoffOptions {
  const s = getSettings();
  let whatsappUrl: string | null = null;

  if (s.whatsapp_number) {
    const digits = s.whatsapp_number.replace(/[^\d]/g, '');
    if (digits) {
      const preface =
        language === 'ar'
          ? 'مرحباً، كنت أتحدث مع المساعد الذكي في Wellness World وأحتاج مساعدة بشرية.'
          : 'Hello, I was chatting with the Wellness World assistant and need help from a person.';
      whatsappUrl = `https://wa.me/${digits}?text=${encodeURIComponent(`${preface}\n\n${summary}`)}`;
    }
  }

  return {
    whatsapp_url: whatsappUrl,
    phone: s.phone_number,
    live_chat_note: s.live_chat_note,
    hours: s.service_hours,
  };
}
