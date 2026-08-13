/**
 * Environment configuration.
 *
 * Every value that the store owner might want to change lives either here (as
 * an env var) or in the WordPress Business Settings screen — never inline in a
 * prompt or a code path. See spec §8.
 */
import 'dotenv/config';
import path from 'node:path';

function str(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return v;
}

function optional(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${key} must be a number, got "${v}"`);
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

/** True when the process is only exercising pure logic (tests, config lint). */
const lazyKeys = process.env.WELLNESS_LAZY_CONFIG === '1';

export const config = {
  env: optional('NODE_ENV', 'development'),
  isProduction: optional('NODE_ENV', 'development') === 'production',
  logLevel: optional('LOG_LEVEL', 'info'),

  server: {
    port: num('PORT', 8787),
    host: optional('HOST', '0.0.0.0'),
  },

  openai: {
    apiKey: lazyKeys ? optional('OPENAI_API_KEY') : str('OPENAI_API_KEY', ''),
    /**
     * Model IDs are configuration, not constants — the spec is explicit that any
     * ID hardcoded at authoring time may be retired by build time (§2, §16.7).
     * Defaults verified against OpenAI's live model list on 2026-08-03.
     */
    chatModel: optional('OPENAI_MODEL_CHAT', 'gpt-5.6-terra'),
    cheapModel: optional('OPENAI_MODEL_CHEAP', 'gpt-5.6-luna'),
    labelModel: optional('OPENAI_MODEL_LABEL', 'gpt-5.6-sol'),
    embedModel: optional('OPENAI_MODEL_EMBED', 'text-embedding-3-small'),
    embedDimensions: num('OPENAI_EMBED_DIMENSIONS', 1536),
  },

  db: {
    path: path.resolve(optional('DATABASE_PATH', './data/wellness-chatbot.db')),
  },

  session: {
    ttlMinutes: num('SESSION_TTL_MINUTES', 45),
  },

  wordpress: {
    baseUrl: optional('WP_BASE_URL', '').replace(/\/+$/, ''),
    sharedSecret: optional('WP_SHARED_SECRET'),
    wcConsumerKey: optional('WC_CONSUMER_KEY'),
    wcConsumerSecret: optional('WC_CONSUMER_SECRET'),
  },

  labeling: {
    confidenceThreshold: num('LABEL_CONFIDENCE_THRESHOLD', 0.6),
  },

  rateLimit: {
    sessionPerMin: num('RATE_LIMIT_SESSION_PER_MIN', 20),
    ipPerMin: num('RATE_LIMIT_IP_PER_MIN', 60),
  },

  recommendations: {
    allowPartialVerification: bool('ALLOW_PARTIAL_VERIFICATION', true),
  },
} as const;

export type Config = typeof config;
