/**
 * Per-session and per-IP rate limiting (spec §11).
 *
 * Every chat turn costs money at the OpenAI API, so this protects the store
 * owner's bill as much as it protects the service. In-memory sliding window —
 * this service is a single warm process by design.
 */
import { config } from '../config.js';

interface Bucket {
  hits: number[];
  /** Stored per bucket so the pruner cannot drop a long window early. */
  windowMs: number;
}

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;
const HOUR_MS = 3_600_000;

function take(key: string, limit: number, windowMs = WINDOW_MS): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { hits: [], windowMs };
  bucket.windowMs = windowMs;
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);

  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0] ?? now;
    buckets.set(key, bucket);
    return { allowed: false, retryAfter: Math.ceil((windowMs - (now - oldest)) / 1000) };
  }

  bucket.hits.push(now);
  buckets.set(key, bucket);
  return { allowed: true, retryAfter: 0 };
}

export function checkRateLimit(sessionId: string | undefined, ip: string): { allowed: boolean; retryAfter: number } {
  const byIp = take(`ip:${ip}`, config.rateLimit.ipPerMin);
  if (!byIp.allowed) return byIp;
  if (!sessionId) return byIp;
  return take(`session:${sessionId}`, config.rateLimit.sessionPerMin);
}

/**
 * Analyzer photo uploads, which are the one customer action that costs a
 * vision call. The endpoint behind them is public and unauthenticated, so
 * the shared per-minute chat bucket is the wrong shape: a tight hourly cap
 * is what actually stops someone burning the store's credit in a loop.
 */
export function checkPhotoLimit(
  sessionId: string,
  ip: string,
): { allowed: boolean; retryAfter: number } {
  const perSession = take(`photo:session:${sessionId}`, config.rateLimit.photoPerSession, HOUR_MS);
  if (!perSession.allowed) return perSession;
  return take(`photo:ip:${ip}`, config.rateLimit.photoPerIpHour, HOUR_MS);
}

/** Drops buckets that have gone quiet, so the map cannot grow without bound. */
export function pruneRateLimitBuckets(): void {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.hits.every((t) => now - t >= bucket.windowMs)) buckets.delete(key);
  }
}

export function resetRateLimits(): void {
  buckets.clear();
}
