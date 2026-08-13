/**
 * Vector index over the `embeddings` table.
 *
 * Vectors are Float32 BLOBs scored with cosine similarity in process. For a
 * catalogue of a few thousand SKUs this is sub-millisecond and needs no native
 * extension. Swapping in sqlite-vec / Qdrant later means reimplementing only
 * `upsertVector` and `searchVectors`.
 */
import type { DatabaseSync } from 'node:sqlite';
import { db, nowIso } from '../db/index.js';

export function toBlob(vector: number[]): Buffer {
  const f32 = Float32Array.from(vector);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function fromBlob(blob: Buffer | Uint8Array): Float32Array {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  // Copy so the Float32Array does not alias a pooled Buffer.
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(buf);
  return new Float32Array(copy);
}

export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface VectorHit {
  id: string;
  kind: string;
  ref_id: number;
  content: string;
  similarity: number;
}

export function upsertVector(
  args: { kind: 'product' | 'kb'; refId: number; content: string; vector: number[]; model: string },
  conn: DatabaseSync = db(),
): void {
  const id = `${args.kind}:${args.refId}`;
  conn
    .prepare(
      `INSERT INTO embeddings (id, kind, ref_id, content, vector, dimensions, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         vector = excluded.vector,
         dimensions = excluded.dimensions,
         model = excluded.model,
         created_at = excluded.created_at`,
    )
    .run(id, args.kind, args.refId, args.content, toBlob(args.vector), args.vector.length, args.model, nowIso());
}

export function searchVectors(
  queryVector: number[],
  opts: { kind?: 'product' | 'kb'; limit?: number; minSimilarity?: number } = {},
  conn: DatabaseSync = db(),
): VectorHit[] {
  const limit = opts.limit ?? 10;
  const min = opts.minSimilarity ?? 0;
  const rows = opts.kind
    ? (conn.prepare('SELECT id, kind, ref_id, content, vector FROM embeddings WHERE kind = ?').all(opts.kind) as Record<string, unknown>[])
    : (conn.prepare('SELECT id, kind, ref_id, content, vector FROM embeddings').all() as Record<string, unknown>[]);

  const hits: VectorHit[] = [];
  for (const row of rows) {
    const sim = cosine(queryVector, fromBlob(row.vector as Buffer));
    if (sim >= min) {
      hits.push({
        id: String(row.id),
        kind: String(row.kind),
        ref_id: Number(row.ref_id),
        content: String(row.content),
        similarity: sim,
      });
    }
  }
  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, limit);
}

export function vectorCount(conn: DatabaseSync = db()): number {
  const row = conn.prepare('SELECT COUNT(*) AS c FROM embeddings').get() as Record<string, unknown>;
  return Number(row.c ?? 0);
}
