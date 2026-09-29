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
import { contentTokens, expandQuery, keywordScore } from './normalize.js';
import { typeLabel } from '../products/types.js';
import { searchVectors, upsertVector, type VectorHit } from './vector.js';
import type { KbEntry, Product } from '../types.js';

/** The text a product is embedded as — everything a customer might search by. */
export function productEmbeddingText(p: Product): string {
  const parts = [
    p.name,
    p.name_ar,
    p.brand,
    p.product_type ? `${typeLabel(p.product_type, 'en')} / ${typeLabel(p.product_type, 'ar')}` : null,
    (p.category_paths.length ? p.category_paths : p.categories).join(', '),
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
    // The long fields last, so the 4000-char cap trims them rather than the
    // name, type and labels above.
    p.how_to_use_source.en,
    p.description,
    p.full_ingredients,
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

  // Always fold in a keyword pass so an exact brand or product name cannot
  // be missed. Per word, not the whole sentence: matching "do you have
  // cerave cream" as one substring meant this pass effectively never fired.
  const tokens = contentTokens(expanded.normalized).slice(0, 5);
  if (tokens.length) {
    const clauses = tokens.map(
      () => `(lower(name) LIKE ? OR lower(COALESCE(name_ar,'')) LIKE ? OR lower(COALESCE(brand,'')) LIKE ? OR lower(COALESCE(sku,'')) LIKE ?)`,
    );
    const params = tokens.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`]);
    const keywordRows = db()
      .prepare(`SELECT product_id FROM products WHERE ${clauses.join(' OR ')} LIMIT 80`)
      .all(...params) as Record<string, unknown>[];
    for (const row of keywordRows) candidateIds.add(Number(row.product_id));
  }

  const products = getProducts([...candidateIds]);
  const semanticById = new Map(vectorHits.map((h) => [h.ref_id, h.similarity]));

  const hits: ProductSearchHit[] = products
    .map((product) => {
      const semantic = semanticById.get(product.product_id) ?? 0;
      // Scored against what the customer can see — name, brand, type — so a
      // word buried in a long description can't make a product "match".
      const keyword = keywordScore(
        expanded,
        [product.name, product.name_ar, product.brand, product.sku, product.product_type?.replace(/_/g, ' ')]
          .filter(Boolean)
          .join(' '),
      );
      // Weighted so a strong exact-name match beats a merely similar vector.
      const score = semantic * 0.5 + keyword * 0.5;
      return { product, score, semantic, keyword };
    })
    // A product the customer named shares a word with the query; one that
    // doesn't must at least be semantically close. Without a floor, the top
    // six vectors came back whatever they were.
    .filter((h) => h.keyword > 0 || h.semantic >= MIN_SEMANTIC_ONLY);

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/** Cosine similarity a result needs when no query word appears in its name. */
const MIN_SEMANTIC_ONLY = 0.45;
