/**
 * WooCommerce categories → shelves, decided once per category instead of
 * guessed per product.
 *
 * The store has ~50 real categories and every product is already filed in
 * them. Before this, a product's shelf was a keyword regex over its category
 * *names* ("mask" → face, checked before "hair" → hair, so a Hair Mask
 * category resolved to Face Care). Now each category is mapped exactly once —
 * by the AI as a suggestion, then confirmed by the admin — and every product
 * in it inherits that decision. The regex in `category.ts` survives only as a
 * fallback for a category nobody has mapped yet.
 */
import type { DatabaseSync } from 'node:sqlite';
import { db, nowIso } from '../db/index.js';
import { logAudit } from '../analytics/audit.js';
import { isLikelyMedicine, isProductCategory, resolveProductCategory, type ProductCategory } from './category.js';
import { isProductType, typeShelf, type ProductType } from './types.js';
import type { Product } from '../types.js';

/** What a category can be mapped to: a shelf, "medicine", or "tells us nothing" (brands, offers). */
export type MappedShelf = ProductCategory | 'medicine' | 'none';

export const MAPPED_SHELVES: MappedShelf[] = ['face', 'hair', 'body', 'vitamins', 'general', 'medicine', 'none'];

export function isMappedShelf(value: unknown): value is MappedShelf {
  return typeof value === 'string' && (MAPPED_SHELVES as string[]).includes(value);
}

export interface WooCategoryInput {
  id: number;
  name: string;
  slug?: string;
  parent?: number | null;
  path?: string | null;
}

export interface CategoryMapRow {
  woo_category_id: number;
  name: string;
  slug: string | null;
  parent_id: number | null;
  path: string;
  /** Admin-confirmed; null until someone saves this row. */
  shelf: MappedShelf | null;
  fixed_product_type: ProductType | null;
  suggested_shelf: MappedShelf | null;
  suggested_product_type: ProductType | null;
  /** What actually applies right now: the admin's choice, else the suggestion. */
  effective_shelf: MappedShelf | null;
  effective_product_type: ProductType | null;
  confirmed: boolean;
  product_count: number;
}

interface IndexEntry {
  shelf: MappedShelf | null;
  type: ProductType | null;
  depth: number;
}

const indexCache = new WeakMap<DatabaseSync, Map<number, IndexEntry>>();

function invalidate(conn: DatabaseSync): void {
  indexCache.delete(conn);
}

function toRow(r: Record<string, unknown>, counts: Map<number, number>): CategoryMapRow {
  const shelf = isMappedShelf(r.shelf) ? r.shelf : null;
  const fixed = isProductType(r.fixed_product_type) ? r.fixed_product_type : null;
  const suggestedShelf = isMappedShelf(r.suggested_shelf) ? r.suggested_shelf : null;
  const suggestedType = isProductType(r.suggested_product_type) ? r.suggested_product_type : null;
  const id = Number(r.woo_category_id);
  return {
    woo_category_id: id,
    name: String(r.name ?? ''),
    slug: (r.slug as string) ?? null,
    parent_id: r.parent_id === null || r.parent_id === undefined ? null : Number(r.parent_id),
    path: String(r.path ?? r.name ?? ''),
    shelf,
    fixed_product_type: fixed,
    suggested_shelf: suggestedShelf,
    suggested_product_type: suggestedType,
    // Once an admin has saved a row, their (possibly empty) type choice
    // stands — an unset fixed type means "decide per product", not "fall
    // back to what the AI suggested".
    effective_shelf: shelf ?? suggestedShelf,
    effective_product_type: shelf ? fixed : suggestedType,
    confirmed: shelf !== null,
    product_count: counts.get(id) ?? 0,
  };
}

/**
 * Records every category a synced product carries. Name, slug, parent and
 * path follow WooCommerce; the mapping columns are never touched here, so a
 * re-sync can't undo an admin's decision.
 */
export function upsertCategories(categories: WooCategoryInput[], conn: DatabaseSync = db()): void {
  if (categories.length === 0) return;
  const stmt = conn.prepare(
    `INSERT INTO category_map (woo_category_id, name, slug, parent_id, path, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(woo_category_id) DO UPDATE SET
       name = excluded.name,
       slug = excluded.slug,
       parent_id = COALESCE(excluded.parent_id, category_map.parent_id),
       path = COALESCE(excluded.path, category_map.path)`,
  );
  for (const c of categories) {
    if (!c.id || !c.name) continue;
    stmt.run(c.id, c.name, c.slug ?? null, c.parent ?? null, c.path ?? null, nowIso());
  }
  invalidate(conn);
}

function productCounts(conn: DatabaseSync): Map<number, number> {
  const counts = new Map<number, number>();
  const rows = conn.prepare('SELECT woo_category_ids_json FROM products').all() as Record<string, unknown>[];
  for (const row of rows) {
    let ids: unknown = [];
    try {
      ids = JSON.parse(String(row.woo_category_ids_json ?? '[]'));
    } catch {
      ids = [];
    }
    if (!Array.isArray(ids)) continue;
    for (const id of ids) counts.set(Number(id), (counts.get(Number(id)) ?? 0) + 1);
  }
  return counts;
}

export function listCategoryMap(conn: DatabaseSync = db()): CategoryMapRow[] {
  const counts = productCounts(conn);
  const rows = conn.prepare('SELECT * FROM category_map ORDER BY path COLLATE NOCASE').all() as Record<string, unknown>[];
  return rows.map((r) => toRow(r, counts));
}

export interface MappingDecision {
  woo_category_id: number;
  shelf: MappedShelf;
  fixed_product_type?: ProductType | null;
}

export function saveCategoryMappings(
  decisions: MappingDecision[],
  actor: string | undefined,
  conn: DatabaseSync = db(),
): number {
  const stmt = conn.prepare(
    `UPDATE category_map SET shelf = ?, fixed_product_type = ?, updated_at = ?, updated_by = ? WHERE woo_category_id = ?`,
  );
  let saved = 0;
  for (const d of decisions) {
    if (!isMappedShelf(d.shelf)) continue;
    const type = isProductType(d.fixed_product_type) ? d.fixed_product_type : null;
    const res = stmt.run(d.shelf, type, nowIso(), actor ?? null, d.woo_category_id);
    saved += Number(res.changes ?? 0);
  }
  invalidate(conn);
  logAudit({ entity: 'settings', entityId: 'category_map', action: 'category_map_saved', actor, detail: { saved } }, conn);
  return saved;
}

export function saveCategorySuggestions(
  suggestions: { woo_category_id: number; shelf: MappedShelf; product_type: ProductType | null }[],
  conn: DatabaseSync = db(),
): number {
  const stmt = conn.prepare(
    `UPDATE category_map SET suggested_shelf = ?, suggested_product_type = ?, updated_at = ? WHERE woo_category_id = ?`,
  );
  let saved = 0;
  for (const s of suggestions) {
    if (!isMappedShelf(s.shelf)) continue;
    const res = stmt.run(s.shelf, isProductType(s.product_type) ? s.product_type : null, nowIso(), s.woo_category_id);
    saved += Number(res.changes ?? 0);
  }
  invalidate(conn);
  return saved;
}

function loadIndex(conn: DatabaseSync): Map<number, IndexEntry> {
  const cached = indexCache.get(conn);
  if (cached) return cached;
  const index = new Map<number, IndexEntry>();
  for (const row of listCategoryMapRaw(conn)) {
    index.set(row.id, row.entry);
  }
  indexCache.set(conn, index);
  return index;
}

function listCategoryMapRaw(conn: DatabaseSync): { id: number; entry: IndexEntry }[] {
  const rows = conn.prepare('SELECT * FROM category_map').all() as Record<string, unknown>[];
  return rows.map((r) => {
    const row = toRow(r, new Map());
    return {
      id: row.woo_category_id,
      entry: {
        shelf: row.effective_shelf,
        type: row.effective_product_type,
        depth: row.path.split('>').length,
      },
    };
  });
}

export interface CategoryResolution {
  /** Null when none of the product's categories is mapped to a shelf. */
  shelf: ProductCategory | null;
  /** True when any of its categories is mapped to "medicine". */
  medicine: boolean;
  /** A type every product in the category shares ("Shampoos" → shampoo), if one was set. */
  fixedType: ProductType | null;
}

/**
 * Resolves a product's categories through the map. The deepest mapped
 * category wins ("Hair Care > Shampoo" beats "Hair Care"), and "none"
 * categories — brands, "New arrivals", "Offers" — are ignored entirely.
 */
export function resolveFromCategories(wooCategoryIds: number[], conn?: DatabaseSync): CategoryResolution {
  // No categories, no lookup — and no database handle opened just to find
  // that out (this runs inside every eligibility check).
  if (!wooCategoryIds || wooCategoryIds.length === 0) return { shelf: null, medicine: false, fixedType: null };
  const index = loadIndex(conn ?? db());
  let best: IndexEntry | null = null;
  let bestTyped: IndexEntry | null = null;
  let medicine = false;

  for (const id of wooCategoryIds) {
    const entry = index.get(id);
    if (!entry || !entry.shelf || entry.shelf === 'none') continue;
    if (entry.shelf === 'medicine') {
      medicine = true;
      continue;
    }
    if (!best || entry.depth > best.depth) best = entry;
    if (entry.type && (!bestTyped || entry.depth > bestTyped.depth)) bestTyped = entry;
  }

  const shelf = best && isProductCategory(best.shelf ?? '') ? (best.shelf as ProductCategory) : medicine ? 'general' : null;
  return { shelf, medicine, fixedType: bestTyped?.type ?? null };
}

type ShelfInput = Pick<Product, 'product_type' | 'woo_category_ids' | 'categories' | 'tags' | 'name'>;

/**
 * The shelf a product belongs on, most reliable source first:
 *
 *  1. its product type — a shampoo is a hair product whatever it was filed under
 *     ("other" and "gift_set" say nothing about a shelf, so they skip this);
 *  2. the admin-confirmed category map;
 *  3. the old keyword guess, only for categories nobody has mapped yet.
 *
 * `ignoreType` is for labelling, which has to pick a shelf before the product
 * has a type.
 */
export function productShelf(
  product: ShelfInput,
  opts: { ignoreType?: boolean; conn?: DatabaseSync } = {},
): ProductCategory {
  const type = product.product_type;
  if (!opts.ignoreType && type && type !== 'other' && type !== 'gift_set') return typeShelf(type);

  const mapped = resolveFromCategories(product.woo_category_ids ?? [], opts.conn);
  if (mapped.shelf) return mapped.shelf;

  return resolveProductCategory({ categories: product.categories, tags: product.tags, name: product.name });
}

/**
 * Whether a product is a medicine, on ANY shelf. The type and the category
 * map are authoritative; the name heuristic (strength + dosage form) only
 * applies off the vitamins shelf, where "Vitamin C 500mg Tablets" is a
 * supplement, not a medicine.
 */
export function isMedicineProduct(product: ShelfInput, conn?: DatabaseSync): boolean {
  if (product.product_type === 'medicine') return true;
  if (resolveFromCategories(product.woo_category_ids ?? [], conn).medicine) return true;
  if (product.product_type && product.product_type.startsWith('supplement_')) return false;
  const shelf = productShelf(product, { conn });
  if (shelf === 'vitamins') return false;
  return isLikelyMedicine({ categories: product.categories, tags: product.tags, name: product.name });
}
