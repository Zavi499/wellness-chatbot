/**
 * Product persistence. Maps between the flat SQLite row and the `Product`
 * domain object (the `_wwc_*` schema in spec §3.2).
 */
import type { DatabaseSync } from 'node:sqlite';
import { db, parseJson, toJson, nowIso } from '../db/index.js';
import type {
  AgeSuitability,
  Bilingual,
  BilingualList,
  Product,
  TriState,
  VerificationStatus,
} from '../types.js';

const EMPTY_LIST: BilingualList = { en: [], ar: [] };
const EMPTY_BILINGUAL: Bilingual = { en: null, ar: null };

type Row = Record<string, unknown>;

export function rowToProduct(row: Row): Product {
  const pregnancyRaw = row.pregnancy_guidance_json;
  let pregnancy: Product['pregnancy_guidance'] = null;
  if (typeof pregnancyRaw === 'string' && pregnancyRaw !== '') {
    pregnancy =
      pregnancyRaw === '"refer_to_pharmacist"' || pregnancyRaw === 'refer_to_pharmacist'
        ? 'refer_to_pharmacist'
        : parseJson<Bilingual>(pregnancyRaw, EMPTY_BILINGUAL);
  }

  return {
    product_id: Number(row.product_id),
    sku: (row.sku as string) ?? null,
    name: String(row.name ?? ''),
    name_ar: (row.name_ar as string) ?? null,
    permalink: (row.permalink as string) ?? null,
    image_url: (row.image_url as string) ?? null,
    short_description: (row.short_description as string) ?? null,
    description: (row.description as string) ?? null,
    categories: parseJson<string[]>(row.categories_json, []),
    tags: parseJson<string[]>(row.tags_json, []),
    brand: (row.brand as string) ?? null,
    price: row.price === null || row.price === undefined ? null : Number(row.price),
    regular_price:
      row.regular_price === null || row.regular_price === undefined ? null : Number(row.regular_price),
    sale_price: row.sale_price === null || row.sale_price === undefined ? null : Number(row.sale_price),
    currency: String(row.currency ?? 'KWD'),
    size: (row.size as string) ?? null,
    stock_status: (row.stock_status as Product['stock_status']) ?? 'instock',
    rating_average:
      row.rating_average === null || row.rating_average === undefined ? null : Number(row.rating_average),
    rating_count: Number(row.rating_count ?? 0),

    verification_status: (row.verification_status as VerificationStatus) ?? 'unverified',
    ai_generated: Number(row.ai_generated ?? 0) === 1,
    ai_confidence:
      row.ai_confidence === null || row.ai_confidence === undefined ? null : Number(row.ai_confidence),
    requires_pharmacist_review: Number(row.requires_pharmacist_review ?? 0) === 1,
    verified_by_pharmacist: Number(row.verified_by_pharmacist ?? 0) === 1,

    concern_primary: parseJson<BilingualList>(row.concern_primary_json, EMPTY_LIST),
    concern_secondary: parseJson<BilingualList>(row.concern_secondary_json, EMPTY_LIST),
    suitable_types: parseJson<BilingualList>(row.suitable_types_json, EMPTY_LIST),
    not_ideal_for: parseJson<Bilingual>(row.not_ideal_for_json, EMPTY_BILINGUAL),
    key_ingredients: parseJson<string[]>(row.key_ingredients_json, []),
    full_ingredients: (row.full_ingredients as string) ?? null,
    texture_finish: parseJson<Bilingual>(row.texture_finish_json, EMPTY_BILINGUAL),
    fragrance: (row.fragrance as TriState) ?? 'unspecified',
    fragrance_type: (row.fragrance_type as string) ?? null,
    alcohol: (row.alcohol as TriState) ?? 'unspecified',
    alcohol_type: (row.alcohol_type as string) ?? null,
    how_to_use: parseJson<Bilingual>(row.how_to_use_json, EMPTY_BILINGUAL),
    routine_step: (row.routine_step as string) ?? null,
    routine_time: (row.routine_time as Product['routine_time']) ?? null,
    age_suitability: (row.age_suitability as AgeSuitability) ?? 'all',
    age_min: row.age_min === null || row.age_min === undefined ? null : Number(row.age_min),
    age_max: row.age_max === null || row.age_max === undefined ? null : Number(row.age_max),
    pregnancy_guidance: pregnancy,
    warnings: parseJson<Bilingual>(row.warnings_json, EMPTY_BILINGUAL),
    complementary_products: parseJson<number[]>(row.complementary_products_json, []),
    alternative_products: parseJson<number[]>(row.alternative_products_json, []),
    source_verification_date: (row.source_verification_date as string) ?? null,
    source_verification_note: (row.source_verification_note as string) ?? null,
    synonyms_en: parseJson<string[]>(row.synonyms_en_json, []),
    synonyms_ar: parseJson<string[]>(row.synonyms_ar_json, []),
    updated_at: String(row.updated_at ?? ''),
  };
}

const UPSERT = `
INSERT INTO products (
  product_id, sku, name, name_ar, permalink, image_url, short_description, description,
  categories_json, tags_json, brand, price, regular_price, sale_price, currency, size,
  stock_status, rating_average, rating_count, updated_at, synced_at
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?
)
ON CONFLICT(product_id) DO UPDATE SET
  sku = excluded.sku,
  name = excluded.name,
  permalink = excluded.permalink,
  image_url = excluded.image_url,
  short_description = excluded.short_description,
  description = excluded.description,
  categories_json = excluded.categories_json,
  tags_json = excluded.tags_json,
  brand = excluded.brand,
  price = excluded.price,
  regular_price = excluded.regular_price,
  sale_price = excluded.sale_price,
  currency = excluded.currency,
  size = excluded.size,
  stock_status = excluded.stock_status,
  rating_average = excluded.rating_average,
  rating_count = excluded.rating_count,
  updated_at = excluded.updated_at,
  synced_at = excluded.synced_at
`;

/**
 * Writes the WooCommerce-owned half of a product. Deliberately does NOT touch
 * any `_wwc_*` column: a re-sync from the store must never silently undo a
 * pharmacist's verification (spec §3.1).
 */
export function upsertWooFields(
  p: Pick<
    Product,
    | 'product_id'
    | 'sku'
    | 'name'
    | 'permalink'
    | 'image_url'
    | 'short_description'
    | 'description'
    | 'categories'
    | 'tags'
    | 'brand'
    | 'price'
    | 'regular_price'
    | 'sale_price'
    | 'currency'
    | 'size'
    | 'stock_status'
    | 'rating_average'
    | 'rating_count'
  >,
  conn: DatabaseSync = db(),
): void {
  conn
    .prepare(UPSERT)
    .run(
      p.product_id,
      p.sku,
      p.name,
      null,
      p.permalink,
      p.image_url,
      p.short_description,
      p.description,
      toJson(p.categories),
      toJson(p.tags),
      p.brand,
      p.price,
      p.regular_price,
      p.sale_price,
      p.currency,
      p.size,
      p.stock_status,
      p.rating_average,
      p.rating_count,
      nowIso(),
      nowIso(),
    );
}

/** Column names that the labeling pipeline and the admin review queue may write. */
const WWC_COLUMNS: Record<string, string> = {
  name_ar: 'name_ar',
  verification_status: 'verification_status',
  ai_generated: 'ai_generated',
  ai_confidence: 'ai_confidence',
  requires_pharmacist_review: 'requires_pharmacist_review',
  verified_by_pharmacist: 'verified_by_pharmacist',
  concern_primary: 'concern_primary_json',
  concern_secondary: 'concern_secondary_json',
  suitable_types: 'suitable_types_json',
  not_ideal_for: 'not_ideal_for_json',
  key_ingredients: 'key_ingredients_json',
  full_ingredients: 'full_ingredients',
  texture_finish: 'texture_finish_json',
  fragrance: 'fragrance',
  fragrance_type: 'fragrance_type',
  alcohol: 'alcohol',
  alcohol_type: 'alcohol_type',
  how_to_use: 'how_to_use_json',
  routine_step: 'routine_step',
  routine_time: 'routine_time',
  age_suitability: 'age_suitability',
  age_min: 'age_min',
  age_max: 'age_max',
  pregnancy_guidance: 'pregnancy_guidance_json',
  warnings: 'warnings_json',
  complementary_products: 'complementary_products_json',
  alternative_products: 'alternative_products_json',
  source_verification_date: 'source_verification_date',
  source_verification_note: 'source_verification_note',
  synonyms_en: 'synonyms_en_json',
  synonyms_ar: 'synonyms_ar_json',
};

const JSON_COLUMNS = new Set(Object.values(WWC_COLUMNS).filter((c) => c.endsWith('_json')));
const BOOL_FIELDS = new Set(['ai_generated', 'requires_pharmacist_review', 'verified_by_pharmacist']);

/** Applies a partial `_wwc_*` update. Unknown keys are ignored, not thrown. */
export function updateWwcFields(
  productId: number,
  patch: Record<string, unknown>,
  conn: DatabaseSync = db(),
): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [field, value] of Object.entries(patch)) {
    const column = WWC_COLUMNS[field];
    if (!column) continue;
    sets.push(`${column} = ?`);
    if (JSON_COLUMNS.has(column)) {
      values.push(toJson(value));
    } else if (BOOL_FIELDS.has(field)) {
      values.push(value ? 1 : 0);
    } else if (value === null || value === undefined) {
      values.push(null);
    } else if (typeof value === 'number') {
      values.push(value);
    } else {
      values.push(String(value));
    }
  }

  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(nowIso());
  values.push(productId);

  conn.prepare(`UPDATE products SET ${sets.join(', ')} WHERE product_id = ?`).run(...values);
}

export function getProduct(productId: number, conn: DatabaseSync = db()): Product | null {
  const row = conn.prepare('SELECT * FROM products WHERE product_id = ?').get(productId) as Row | undefined;
  return row ? rowToProduct(row) : null;
}

export function getProducts(ids: number[], conn: DatabaseSync = db()): Product[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = conn
    .prepare(`SELECT * FROM products WHERE product_id IN (${placeholders})`)
    .all(...ids) as Row[];
  return rows.map(rowToProduct);
}

export function allProducts(conn: DatabaseSync = db()): Product[] {
  return (conn.prepare('SELECT * FROM products').all() as Row[]).map(rowToProduct);
}

export function deleteProduct(productId: number, conn: DatabaseSync = db()): void {
  conn.prepare('DELETE FROM products WHERE product_id = ?').run(productId);
  conn.prepare(`DELETE FROM embeddings WHERE id = ?`).run(`product:${productId}`);
}

export function setStockStatus(
  productId: number,
  status: Product['stock_status'],
  conn: DatabaseSync = db(),
): void {
  conn
    .prepare('UPDATE products SET stock_status = ?, updated_at = ? WHERE product_id = ?')
    .run(status, nowIso(), productId);
}

export function countProducts(conn: DatabaseSync = db()): { total: number; verified: number; queued: number } {
  const total = Number(
    (conn.prepare('SELECT COUNT(*) AS c FROM products').get() as Row).c ?? 0,
  );
  const verified = Number(
    (
      conn
        .prepare(`SELECT COUNT(*) AS c FROM products WHERE verification_status IN ('verified','partial')`)
        .get() as Row
    ).c ?? 0,
  );
  const queued = Number(
    (conn.prepare(`SELECT COUNT(*) AS c FROM label_drafts WHERE status = 'pending'`).get() as Row).c ?? 0,
  );
  return { total, verified, queued };
}
