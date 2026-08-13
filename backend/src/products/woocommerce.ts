/**
 * WooCommerce REST client + normalizer.
 *
 * WooCommerce stays the system of record. This module pulls product data in
 * (full backfill or a single product after a webhook) and normalizes it into
 * the shape `products/repository.ts` stores.
 */
import { config } from '../config.js';
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

function authHeader(): string {
  const { wcConsumerKey, wcConsumerSecret } = config.wordpress;
  return 'Basic ' + Buffer.from(`${wcConsumerKey}:${wcConsumerSecret}`).toString('base64');
}

function requireWooCredentials(): void {
  if (!config.wordpress.baseUrl) throw new Error('WP_BASE_URL is not configured.');
  if (!config.wordpress.wcConsumerKey || !config.wordpress.wcConsumerSecret) {
    throw new Error('WC_CONSUMER_KEY / WC_CONSUMER_SECRET are not configured.');
  }
}

async function wooGet<T>(pathname: string, params: Record<string, string | number> = {}): Promise<T> {
  requireWooCredentials();
  const url = new URL(`${config.wordpress.baseUrl}/wp-json/wc/v3${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url, { headers: { Authorization: authHeader(), Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WooCommerce GET ${pathname} failed: ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function fetchProduct(productId: number): Promise<WooRawProduct> {
  return wooGet<WooRawProduct>(`/products/${productId}`);
}

/** Pulls the whole catalogue, one page at a time. */
export async function* iterateProducts(perPage = 50): AsyncGenerator<WooRawProduct[]> {
  let page = 1;
  for (;;) {
    const batch = await wooGet<WooRawProduct[]>('/products', {
      per_page: perPage,
      page,
      status: 'publish',
      orderby: 'id',
      order: 'asc',
    });
    if (!Array.isArray(batch) || batch.length === 0) return;
    yield batch;
    if (batch.length < perPage) return;
    page += 1;
  }
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

/** Full-catalogue backfill (roadmap phase 2). Returns the number synced. */
export async function backfillCatalogue(
  onBatch?: (count: number, total: number) => void,
): Promise<number> {
  let total = 0;
  for await (const batch of iterateProducts()) {
    for (const raw of batch) {
      upsertWooFields(normalizeWooProduct(raw));
      total += 1;
    }
    onBatch?.(batch.length, total);
  }
  return total;
}

export async function syncSingleProduct(productId: number): Promise<Product['product_id']> {
  const raw = await fetchProduct(productId);
  upsertWooFields(normalizeWooProduct(raw));
  return raw.id;
}
