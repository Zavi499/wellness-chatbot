/**
 * Embedding generation and hybrid retrieval.
 *
 * Retrieval is deliberately hybrid: embeddings catch novel phrasings and
 * misspellings, the synonym/keyword pass catches exact brand and product-type
 * language that embeddings sometimes smear together (spec §6.3).
 */
import { db } from '../db/index.js';
import { openai, models } from '../openai/client.js';
import { config } from '../config.js';
import { allProducts, getProducts } from '../products/repository.js';
import { expandQuery, keywordScore } from './normalize.js';
import { searchVectors, upsertVector, type VectorHit } from './vector.js';
import type { KbEntry, Product } from '../types.js';

/** The text a product is embedded as — everything a customer might search by. */
export function productEmbeddingText(p: Product): string {
  const parts = [
    p.name,
    p.name_ar,
    p.brand,
    p.categories.join(', '),
    p.tags.join(', '),
    p.concern_primary.en.join(', '),
    p.concern_primary.ar.join(', '),
    p.concern_secondary.en.join(', '),
    p.suitable_types.en.join(', '),
    p.suitable_types.ar.join(', '),
    p.key_ingredients.join(', '),
    p.texture_finish.en,
    p.routine_step,
    p.synonyms_en.join(', '),
    p.synonyms_ar.join(', '),
    p.short_description,
  ];
  return parts.filter(Boolean).join('\n').slice(0, 4000);
}

export function kbEmbeddingText(e: KbEntry): string {
  return [e.topic, e.question_en, e.question_ar, e.answer_en, e.answer_ar]
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await openai().embeddings.create({
    model: models.embed(),
    input: texts,
    dimensions: config.openai.embedDimensions,
  });
  return res.data.map((d) => d.embedding as number[]);
}

export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embed([text]);
  if (!v) throw new Error('Embedding request returned no vector.');
  return v;
}

/** Rebuilds the product half of the index. Batched to stay within rate limits. */
export async function reindexProducts(
  onProgress?: (done: number, total: number) => void,
  batchSize = 64,
): Promise<number> {
  const products = allProducts();
  let done = 0;
  for (let i = 0; i < products.length; i += batchSize) {
    const batch = products.slice(i, i + batchSize);
    const texts = batch.map(productEmbeddingText);
    const vectors = await embed(texts);
    batch.forEach((p, idx) => {
      const vector = vectors[idx];
      if (!vector) return;
      upsertVector({
        kind: 'product',
        refId: p.product_id,
        content: texts[idx] ?? '',
        vector,
        model: models.embed(),
      });
    });
    done += batch.length;
    onProgress?.(done, products.length);
  }
  return done;
}

export async function reindexProduct(p: Product): Promise<void> {
  const text = productEmbeddingText(p);
  upsertVector({
    kind: 'product',
    refId: p.product_id,
    content: text,
    vector: await embedOne(text),
    model: models.embed(),
  });
}

export async function reindexKbEntry(entry: KbEntry): Promise<void> {
  const text = kbEmbeddingText(entry);
  upsertVector({
    kind: 'kb',
    refId: entry.id,
    content: text,
    vector: await embedOne(text),
    model: models.embed(),
  });
}

export interface ProductSearchHit {
  product: Product;
  score: number;
  semantic: number;
  keyword: number;
}

/**
 * Semantic + keyword search over the catalogue. Used by the `search_products`
 * tool when a customer names a brand or product instead of using the
 * questionnaire.
 */
export async function searchProducts(query: string, limit = 8): Promise<ProductSearchHit[]> {
  const expanded = expandQuery(query);

  let vectorHits: VectorHit[] = [];
  try {
    vectorHits = searchVectors(await embedOne(expanded.normalized || query), {
      kind: 'product',
      limit: limit * 4,
    });
  } catch {
    // Embeddings unavailable (no key, offline, quota) — fall back to keyword
    // only rather than failing the customer's search outright.
    vectorHits = [];
  }

  const candidateIds = new Set(vectorHits.map((h) => h.ref_id));

  // Always fold in a keyword pass so an exact brand match cannot be missed.
  const keywordRows = db()
    .prepare(
      `SELECT product_id FROM products
       WHERE lower(name) LIKE ? OR lower(COALESCE(brand,'')) LIKE ? OR lower(COALESCE(sku,'')) LIKE ?
       LIMIT 50`,
    )
    .all(`%${expanded.normalized}%`, `%${expanded.normalized}%`, `%${expanded.normalized}%`) as Record<
    string,
    unknown
  >[];
  for (const row of keywordRows) candidateIds.add(Number(row.product_id));

  const products = getProducts([...candidateIds]);
  const semanticById = new Map(vectorHits.map((h) => [h.ref_id, h.similarity]));

  const hits: ProductSearchHit[] = products.map((product) => {
    const semantic = semanticById.get(product.product_id) ?? 0;
    const keyword = keywordScore(expanded, productEmbeddingText(product));
    // Weighted so a strong exact-name match beats a merely similar vector.
    const score = semantic * 0.6 + keyword * 0.4;
    return { product, score, semantic, keyword };
  });

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
