/**
 * SQLite access.
 *
 * Uses Node's built-in `node:sqlite` (Node >= 22.5) so the service has no
 * native build step on the host. If the catalogue ever outgrows in-process
 * cosine search, swap the `embeddings` table for Qdrant/pgvector — nothing
 * outside `search/vector.ts` depends on the storage choice.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let instance: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (instance) return instance;
  const file = config.db.path;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  instance = new DatabaseSync(file);
  migrate(instance);
  return instance;
}

/** Opens an isolated in-memory database. Used by the test suite. */
export function openMemoryDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  migrate(d);
  return d;
}

function migrate(d: DatabaseSync): void {
  // `schema.sql` sits next to this file in src/ and is copied to dist/ by the
  // build script; fall back to the source tree when running via tsx.
  const candidates = [path.join(here, 'schema.sql'), path.join(here, '..', '..', 'src', 'db', 'schema.sql')];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`Could not locate schema.sql (looked in ${candidates.join(', ')})`);
  d.exec(fs.readFileSync(found, 'utf8'));
  d.prepare(`INSERT OR REPLACE INTO schema_meta(key, value) VALUES('version', ?)`).run('1');
}

/** Small helpers so callers do not repeat JSON.parse guards everywhere. */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function nowIso(): string {
  return new Date().toISOString();
}
