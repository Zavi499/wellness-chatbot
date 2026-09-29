/**
 * Admin endpoints behind the plugin's "Recommendation Accuracy" screen:
 * the category map, product-type review, and "test a question".
 *
 * Registered from inside `adminRoutes()` so it shares that plugin's signed-
 * request guard — Fastify hooks are scoped to the plugin that adds them.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { openai, models } from '../openai/client.js';
import { allProducts } from '../products/repository.js';
import {
  isMappedShelf,
  listCategoryMap,
  productShelf,
  saveCategoryMappings,
  type MappingDecision,
} from '../products/category-map.js';
import { suggestCategoryMappings } from '../products/category-suggest.js';
import { PRODUCT_TYPES, PRODUCT_TYPE_KEYS, isProductType, typeLabel } from '../products/types.js';
import { setProductTypeByAdmin } from '../labeling/pipeline.js';
import { reindexProduct, searchProducts } from '../search/embeddings.js';
import { findProducts, needHits, profileForRequest, type FindRequest } from '../recommend/find.js';
import { checkEligibility } from '../recommend/eligibility.js';
import { MASTER_SYSTEM_PROMPT } from '../chat/prompts/system.js';
import { TOOL_DEFINITIONS } from '../chat/tools.js';
import type { Product } from '../types.js';

function actorOf(request: FastifyRequest): string {
  return (request.headers['x-wellness-user'] as string) ?? 'unknown';
}

function productRow(p: Product) {
  return {
    product_id: p.product_id,
    name: p.name,
    image_url: p.image_url,
    product_type: p.product_type,
    product_type_label: p.product_type ? typeLabel(p.product_type) : null,
    type_source: p.product_type_source,
    application: p.application,
    shelf: productShelf(p),
    categories: p.category_paths.length ? p.category_paths : p.categories,
    label_issues: p.label_issues,
    verification_status: p.verification_status,
    stock_status: p.stock_status,
  };
}

export async function accuracyRoutes(app: FastifyInstance): Promise<void> {
  // --- Product-type vocabulary, for the admin dropdowns ---------------------
  app.get('/api/admin/product-types', async () => ({
    types: PRODUCT_TYPE_KEYS.map((key) => ({ key, label: PRODUCT_TYPES[key].en, shelf: PRODUCT_TYPES[key].shelf })),
  }));

  // --- Category map ---------------------------------------------------------
  app.get('/api/admin/categories', async () => ({ categories: listCategoryMap() }));

  app.post('/api/admin/categories', async (request, reply) => {
    const body = (request.body ?? {}) as { mappings?: MappingDecision[] };
    if (!Array.isArray(body.mappings)) return reply.code(400).send({ error: 'mappings must be an array' });
    const clean = body.mappings.filter((m) => Number.isFinite(Number(m.woo_category_id)) && isMappedShelf(m.shelf));
    const saved = saveCategoryMappings(
      clean.map((m) => ({
        woo_category_id: Number(m.woo_category_id),
        shelf: m.shelf,
        fixed_product_type: isProductType(m.fixed_product_type) ? m.fixed_product_type : null,
      })),
      actorOf(request),
    );
    return { ok: true, saved, categories: listCategoryMap() };
  });

  app.post('/api/admin/categories/suggest', async (request, reply) => {
    const body = (request.body ?? {}) as { only_unconfirmed?: boolean };
    try {
      const result = await suggestCategoryMappings({ onlyUnconfirmed: body.only_unconfirmed === true });
      return { ok: true, ...result, categories: listCategoryMap() };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Product types ---------------------------------------------------------
  app.get('/api/admin/accuracy/summary', async () => {
    const products = allProducts();
    const byType: Record<string, number> = {};
    let untyped = 0;
    let withIssues = 0;
    for (const p of products) {
      if (p.product_type) byType[p.product_type] = (byType[p.product_type] ?? 0) + 1;
      else if (p.ai_generated) untyped += 1;
      if (p.label_issues.length) withIssues += 1;
    }
    const categories = listCategoryMap();
    return {
      total: products.length,
      untyped_labeled: untyped,
      with_issues: withIssues,
      by_type: byType,
      categories_total: categories.length,
      categories_confirmed: categories.filter((c) => c.confirmed).length,
      categories_unmapped: categories.filter((c) => !c.effective_shelf).length,
    };
  });

  app.get('/api/admin/products', async (request) => {
    const q = request.query as { search?: string; type?: string; issues?: string; limit?: string; offset?: string };
    const search = (q.search ?? '').trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));
    const offset = Math.max(0, Number(q.offset ?? 0));

    let rows = allProducts();
    if (q.issues === '1') rows = rows.filter((p) => p.label_issues.length > 0);
    if (q.type === 'untyped') rows = rows.filter((p) => !p.product_type);
    else if (q.type && isProductType(q.type)) rows = rows.filter((p) => p.product_type === q.type);
    if (search) {
      rows = rows.filter(
        (p) =>
          p.name.toLowerCase().includes(search) ||
          (p.brand ?? '').toLowerCase().includes(search) ||
          String(p.product_id) === search,
      );
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return { total: rows.length, rows: rows.slice(offset, offset + limit).map(productRow) };
  });

  app.post('/api/admin/products/:product_id/type', async (request, reply) => {
    const params = request.params as { product_id: string };
    const body = (request.body ?? {}) as { product_type?: string };
    if (!isProductType(body.product_type)) return reply.code(400).send({ error: 'Unknown product type' });
    try {
      const product = setProductTypeByAdmin(Number(params.product_id), body.product_type, actorOf(request));
      reindexProduct(product).catch((err) => request.log.warn({ err }, 'Re-embedding failed'));
      return { ok: true, product: productRow(product) };
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- "Test a question" -----------------------------------------------------
  // Runs one customer sentence through the real chat model's tool choice and
  // the real engine, and explains the outcome: which tool, what it
  // understood, and why each product was picked — without creating a chat
  // session or showing anything to a customer.
  app.post('/api/admin/accuracy/test', async (request, reply) => {
    const body = (request.body ?? {}) as { question?: string; language?: 'en' | 'ar' };
    const question = (body.question ?? '').trim();
    if (!question) return reply.code(400).send({ error: 'question is required' });
    const language = body.language === 'ar' ? 'ar' : 'en';

    let completion;
    try {
      completion = await openai().chat.completions.create({
        model: models.chat(),
        messages: [
          { role: 'system', content: MASTER_SYSTEM_PROMPT },
          { role: 'user', content: question },
        ],
        tools: TOOL_DEFINITIONS.filter((t) => ['find_products', 'search_products'].includes(t.function.name)),
        tool_choice: 'auto',
      });
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }

    const message = completion.choices[0]?.message;
    const call = message?.tool_calls?.[0];
    if (!call) {
      return { tool: null, reply: message?.content ?? '', note: 'The assistant would reply without looking up products (usually a clarifying question).' };
    }

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      args = {};
    }

    if (call.function.name === 'search_products') {
      const hits = await searchProducts(String(args.query ?? ''), 6);
      return {
        tool: 'search_products',
        understood: args,
        results: hits.map((h) => ({
          ...productRow(h.product),
          score: Math.round(h.score * 100) / 100,
          semantic: Math.round(h.semantic * 100) / 100,
          keyword: Math.round(h.keyword * 100) / 100,
        })),
      };
    }

    const req = args as unknown as FindRequest;
    const found = findProducts(req);
    const types = found.types;
    const catalogue = allProducts();
    const ofType = types.length ? catalogue.filter((p) => p.product_type && types.includes(p.product_type)) : [];
    const profile = types.length ? profileForRequest(req, types) : null;
    const rejected: Record<string, number> = {};
    if (profile) {
      for (const p of ofType) {
        for (const reason of checkEligibility(p, profile).reasons) rejected[reason] = (rejected[reason] ?? 0) + 1;
      }
    }

    return {
      tool: 'find_products',
      understood: args,
      status: found.status,
      products_of_type: ofType.length,
      eligible_of_type: found.eligible_of_type,
      matching_need: found.matching_need,
      held_back: rejected,
      picks: (found.selection?.picks ?? []).map(({ slot, scored }) => ({
        slot,
        ...productRow(scored.product),
        score: scored.score,
        need_hits: needHits(scored.product, req),
        concerns: scored.product.concern_primary.en,
        suitable_types: scored.product.suitable_types.en,
        reasons: scored.reasons,
      })),
      language,
    };
  });
}
