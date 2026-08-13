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
}

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;

function take(key: string, limit: number): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < WINDOW_MS);

  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0] ?? now;
    buckets.set(key, bucket);
    return { allowed: false, retryAfter: Math.ceil((WINDOW_MS - (now - oldest)) / 1000) };
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

/** Drops buckets that have gone quiet, so the map cannot grow without bound. */
export function pruneRateLimitBuckets(): void {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.hits.every((t) => now - t >= WINDOW_MS)) buckets.delete(key);
  }
}

export function resetRateLimits(): void {
  buckets.clear();
}
