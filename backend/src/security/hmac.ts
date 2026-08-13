/**
 * Request signing between the WordPress plugin and this service (spec §2, §11).
 *
 * The widget never holds the shared secret. WordPress signs server-to-server
 * requests; this service verifies the signature and a timestamp so a captured
 * request cannot be replayed.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';

const MAX_SKEW_SECONDS = 300;

export function sign(body: string, timestamp: string, secret = config.wordpress.sharedSecret): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
}

export function verifySignature(
  body: string,
  timestamp: string | undefined,
  signature: string | undefined,
  secret = config.wordpress.sharedSecret,
): VerifyResult {
  if (!secret) return { ok: false, error: 'Shared secret is not configured on the backend.' };
  if (!timestamp || !signature) return { ok: false, error: 'Missing signature headers.' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, error: 'Malformed timestamp.' };

  const skew = Math.abs(Date.now() / 1000 - ts);
  if (skew > MAX_SKEW_SECONDS) return { ok: false, error: 'Request timestamp is outside the allowed window.' };

  const expected = sign(body, timestamp, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'Signature mismatch.' };
  }
  return { ok: true };
}

/**
 * Verifies a WooCommerce webhook signature. WooCommerce sends a base64 HMAC of
 * the raw body under `x-wc-webhook-signature`.
 */
export function verifyWooWebhook(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Short-lived per-session token the plugin mints for the widget. It proves
 * "this browser is talking through our WordPress site" without ever exposing
 * the shared secret to the page.
 */
export function issueSessionToken(sessionId: string, ttlSeconds = 3600): string {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${sessionId}.${expires}`;
  const mac = crypto.createHmac('sha256', config.wordpress.sharedSecret).update(payload).digest('hex');
  return `${payload}.${mac}`;
}

export function verifySessionToken(token: string | undefined, sessionId: string): boolean {
  if (!token || !config.wordpress.sharedSecret) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [tokenSession, expires, mac] = parts as [string, string, string];
  if (tokenSession !== sessionId) return false;
  if (Number(expires) * 1000 < Date.now()) return false;

  const expected = crypto
    .createHmac('sha256', config.wordpress.sharedSecret)
    .update(`${tokenSession}.${expires}`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(mac);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
