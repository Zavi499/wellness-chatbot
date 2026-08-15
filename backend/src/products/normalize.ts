/**
 * WooCommerce product shape + normalizer.
 *
 * The backend never calls the website. Product data arrives two ways, and both
 * funnel through `normalizeWooProduct()` so there is exactly one place that
 * knows how a `WooRawProduct` becomes a stored row:
 *
 *   - live pushes: the WordPress plugin's queue POSTs this shape on save
 *     (routes/webhooks.ts)
 *   - bulk load: the plugin's exporter writes an array of this shape to a
 *     file, which `cli/import.ts` or `/api/admin/catalogue/import` reads
 *
 * Previously this module also pulled data itself over the WooCommerce REST
 * API. That path is gone — on constrained hosting, every pull was a second
 * full WordPress + WooCommerce boot on top of the push that triggered it.
 * Traffic is now one-directional: WordPress → backend, never the reverse.
 */
import { upsertWooFields } from './repository.js';
import type { Product } from '../types.js';

export interface WooRawProduct {
  id: number;
  name: string;
  sku?: string;
  permalink?: string;
  status?: string;
  catalog_visibility?: string;
  description?: string;
  short_description?: string;
  price?: string;
  regular_price?: string;
  sale_price?: string;
  stock_status?: string;
  average_rating?: string;
  rating_count?: number;
  categories?: { id: number; name: string; slug: string }[];
  tags?: { id: number; name: string; slug: string }[];
  images?: { src: string }[];
  attributes?: { name: string; options: string[] }[];
  meta_data?: { key: string; value: unknown }[];
  weight?: string;
  dimensions?: { length?: string; width?: string; height?: string };
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Strips HTML from WooCommerce's rich-text description fields. */
export function stripHtml(html: string | undefined | null): string | null {
  if (!html) return null;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text === '' ? null : text;
}

/**
 * Best-effort size extraction: WooCommerce stores pack size inconsistently, so
 * try an explicit attribute first, then a trailing "240 ml" in the title.
 */
export function extractSize(raw: WooRawProduct): string | null {
  const attr = raw.attributes?.find((a) => /size|volume|weight|حجم/i.test(a.name));
  if (attr?.options?.length) return attr.options.join(', ');
  const m = raw.name?.match(/(\d+(?:\.\d+)?)\s*(ml|l|g|kg|mg|oz|capsules?|tablets?|caps|tabs)\b/i);
  return m ? `${m[1]} ${m[2]}` : null;
}

function extractBrand(raw: WooRawProduct): string | null {
  const attr = raw.attributes?.find((a) => /brand|marque|ماركة/i.test(a.name));
  if (attr?.options?.length && attr.options[0]) return attr.options[0];
  // The store also models brands as a top-level category on some SKUs.
  const brandCat = raw.categories?.find((c) => /^brand/i.test(c.slug));
  return brandCat?.name ?? null;
}

export function normalizeWooProduct(raw: WooRawProduct): Parameters<typeof upsertWooFields>[0] {
  const stock = raw.stock_status === 'outofstock' || raw.stock_status === 'onbackorder'
    ? (raw.stock_status as Product['stock_status'])
    : 'instock';

  return {
    product_id: raw.id,
    sku: raw.sku || null,
    name: raw.name ?? '',
    permalink: raw.permalink ?? null,
    image_url: raw.images?.[0]?.src ?? null,
    short_description: stripHtml(raw.short_description),
    description: stripHtml(raw.description),
    categories: (raw.categories ?? []).map((c) => c.name),
    tags: (raw.tags ?? []).map((t) => t.name),
    brand: extractBrand(raw),
    price: toNumber(raw.price),
    regular_price: toNumber(raw.regular_price),
    sale_price: toNumber(raw.sale_price),
    currency: 'KWD',
    size: extractSize(raw),
    stock_status: stock,
    rating_average: toNumber(raw.average_rating),
    rating_count: Number(raw.rating_count ?? 0),
  };
}
