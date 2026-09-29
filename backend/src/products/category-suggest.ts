/**
 * AI suggestions for the category map — one model call per ~60 categories,
 * not one per product.
 *
 * The model sees each WooCommerce category's full path and a handful of real
 * product names filed in it, and proposes a shelf (and, where every product
 * in it is plainly the same thing, a fixed product type). The suggestions are
 * stored separately from the admin's decisions and only apply until an admin
 * saves the row, so a bad suggestion is one dropdown change to fix.
 */
import type { DatabaseSync } from 'node:sqlite';
import { db } from '../db/index.js';
import { openai, models } from '../openai/client.js';
import { allProducts } from './repository.js';
import {
  listCategoryMap,
  MAPPED_SHELVES,
  saveCategorySuggestions,
  isMappedShelf,
  type MappedShelf,
} from './category-map.js';
import { PRODUCT_TYPE_KEYS, isProductType, typeGlossary, type ProductType } from './types.js';

const BATCH = 60;
const SAMPLES_PER_CATEGORY = 6;

const SYSTEM = `You organise a Kuwaiti pharmacy's WooCommerce categories for a
product-recommendation assistant. For each category decide:

shelf — which consultative shelf its products belong on:
  face      facial skincare (cleansers, serums, moisturisers, face sunscreen …)
  hair      hair and scalp care
  body      body, hand, foot, deodorant, body sunscreen, intimate care
  vitamins  supplements that are swallowed (vitamins, minerals, omega, collagen …)
  general   anything else a pharmacy sells: makeup, baby, oral care, first aid,
            devices, fragrance, sexual wellness, accessories
  medicine  medicines: antibiotics, painkillers, prescription or pharmacy-only drugs
  none      the category says nothing about what the product is — a brand name,
            "New arrivals", "Offers", "Best sellers", "Gifts for her"

product_type — ONLY when every product in the category is plainly the same
kind of thing (a "Shampoos" category → "shampoo"). Otherwise null. Allowed:
${typeGlossary()}

Judge from the category path AND the sample product names — the names show
what is really filed there.`;

function schema() {
  return {
    type: 'object',
    properties: {
      suggestions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            woo_category_id: { type: 'integer' },
            shelf: { type: 'string', enum: MAPPED_SHELVES },
            product_type: { type: ['string', 'null'], enum: [...PRODUCT_TYPE_KEYS, null] },
          },
          required: ['woo_category_id', 'shelf', 'product_type'],
          additionalProperties: false,
        },
      },
    },
    required: ['suggestions'],
    additionalProperties: false,
  };
}

export async function suggestCategoryMappings(
  opts: { onlyUnconfirmed?: boolean } = {},
  conn: DatabaseSync = db(),
): Promise<{ suggested: number; categories: number }> {
  const rows = listCategoryMap(conn).filter((r) => !opts.onlyUnconfirmed || !r.confirmed);
  if (rows.length === 0) return { suggested: 0, categories: 0 };

  const samples = new Map<number, string[]>();
  for (const p of allProducts(conn)) {
    for (const id of p.woo_category_ids) {
      const list = samples.get(id) ?? [];
      if (list.length < SAMPLES_PER_CATEGORY) list.push(p.name);
      samples.set(id, list);
    }
  }

  let suggested = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const listing = batch
      .map((r) => {
        const names = samples.get(r.woo_category_id) ?? [];
        return `#${r.woo_category_id} ${r.path} (${r.product_count} products)\n    e.g. ${names.join(' | ') || '(no products)'}`;
      })
      .join('\n');

    const response = await openai().chat.completions.create({
      model: models.label(),
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Categories:\n${listing}` },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'wwc_category_map', strict: true, schema: schema() },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) continue;
    const parsed = JSON.parse(content) as {
      suggestions: { woo_category_id: number; shelf: string; product_type: string | null }[];
    };
    const valid = new Set(batch.map((r) => r.woo_category_id));
    const clean = parsed.suggestions
      .filter((s) => valid.has(s.woo_category_id) && isMappedShelf(s.shelf))
      .map((s) => ({
        woo_category_id: s.woo_category_id,
        shelf: s.shelf as MappedShelf,
        product_type: isProductType(s.product_type) ? (s.product_type as ProductType) : null,
      }));
    suggested += saveCategorySuggestions(clean, conn);
  }

  return { suggested, categories: rows.length };
}
