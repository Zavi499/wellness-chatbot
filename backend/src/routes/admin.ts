/**
 * Admin endpoints (spec §10).
 *
 * Every route here is reached only via the WordPress plugin's signed
 * server-to-server proxy — admin credentials never touch the browser's calls
 * to this service. The plugin asserts the caller's WP capabilities in headers;
 * this service still re-checks the pharmacist gate itself (spec §11).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { verifySignature } from '../security/hmac.js';
import {
  reviewQueue,
  applyReview,
  labelProduct,
  labelCatalogue,
  resetUnreviewedLabels,
  PharmacistGateError,
} from '../labeling/pipeline.js';
import { listKb, upsertKb, deleteKb, getKbEntry } from '../kb/repository.js';
import { reindexKbEntry, reindexProducts } from '../search/embeddings.js';
import { listEscalations, resolveEscalation } from '../safety/engine.js';
import { kpiSummary, auditTrail } from '../analytics/audit.js';
import { getSettings, setSettings, missingSettings, type SettingKey } from '../settings/repository.js';
import { normalizeWooProduct, type WooRawProduct } from '../products/normalize.js';
import { allProducts, countProducts, deleteProduct, getProduct, upsertWooFields } from '../products/repository.js';
import { loadAllQuestionnaires, saveQuestionnaire, type QuestionnaireId } from '../questionnaire/loader.js';
import { vectorCount } from '../search/vector.js';

interface AdminIdentity {
  user: string;
  isPharmacist: boolean;
}

function identityOf(request: FastifyRequest): AdminIdentity {
  return {
    user: (request.headers['x-wellness-user'] as string) ?? 'unknown',
    // The plugin sets this only after current_user_can('wwc_pharmacist_review').
    isPharmacist: request.headers['x-wellness-pharmacist'] === '1',
  };
}

/** Rejects anything that is not a correctly signed call from the WP plugin. */
async function requireSignedRequest(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const raw = (request as { rawBody?: string }).rawBody ?? (request.body ? JSON.stringify(request.body) : '');
  const result = verifySignature(
    raw,
    request.headers['x-wellness-timestamp'] as string | undefined,
    request.headers['x-wellness-signature'] as string | undefined,
  );
  if (!result.ok) {
    request.log.warn({ reason: result.error }, 'Rejected an admin request');
    await reply.code(401).send({ error: result.error ?? 'Unauthorized' });
    return false;
  }
  return true;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/admin/')) return;
    await requireSignedRequest(request, reply);
  });

  // --- Label Review Queue ---------------------------------------------------
  app.get('/api/admin/labels/queue', async (request) => {
    const q = request.query as { limit?: string; offset?: string };
    return {
      rows: reviewQueue(Number(q.limit ?? 50), Number(q.offset ?? 0)),
      counts: countProducts(),
      // Surfaced so the admin screen can show which model a labeling run will
      // actually bill against before anyone clicks the button.
      models: {
        label: config.openai.labelModel,
        chat: config.openai.chatModel,
        cheap: config.openai.cheapModel,
        embed: config.openai.embedModel,
      },
    };
  });

  app.post('/api/admin/labels/:product_id', async (request, reply) => {
    const params = request.params as { product_id: string };
    const body = (request.body ?? {}) as {
      draft_id?: number;
      action?: 'approve' | 'reject';
      status?: 'verified' | 'partial';
      edits?: Record<string, unknown>;
      note?: string;
    };
    const identity = identityOf(request);

    if (!body.draft_id || (body.action !== 'approve' && body.action !== 'reject')) {
      return reply.code(400).send({ error: 'draft_id and action are required' });
    }

    try {
      const result = applyReview({
        draftId: body.draft_id,
        action: body.action,
        status: body.status,
        edits: body.edits,
        reviewer: identity.user,
        reviewerIsPharmacist: identity.isPharmacist,
        note: body.note,
      });
      return { ok: true, ...result, product_id: Number(params.product_id) };
    } catch (err) {
      if (err instanceof PharmacistGateError) {
        return reply.code(403).send({ error: err.message, code: 'pharmacist_required' });
      }
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/admin/labels/:product_id/relabel', async (request, reply) => {
    const params = request.params as { product_id: string };
    try {
      const result = await labelProduct(Number(params.product_id));
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Discards every unreviewed AI draft (pending or rejected) and resets the
  // affected products back to a clean, never-labeled state. Never touches a
  // product a human has already verified or partially approved — see
  // resetUnreviewedLabels()'s own guard. `confirm` is required so this can
  // never fire from a stray or automated request.
  app.post('/api/admin/labels/reset-unreviewed', async (request, reply) => {
    const body = (request.body ?? {}) as { confirm?: boolean };
    if (body.confirm !== true) {
      return reply.code(400).send({ error: 'Set confirm: true to reset unreviewed AI labels.' });
    }
    const identity = identityOf(request);
    const result = resetUnreviewedLabels(identity.user);
    request.log.warn({ result, actor: identity.user }, 'Unreviewed AI labels reset');
    return { ok: true, ...result, products: countProducts() };
  });

  app.get('/api/admin/labels/:product_id/detail', async (request, reply) => {
    const params = request.params as { product_id: string };
    const product = getProduct(Number(params.product_id));
    if (!product) return reply.code(404).send({ error: 'Product not found' });
    return { product, audit: auditTrail('product', params.product_id, 25) };
  });

  // --- Knowledge base -------------------------------------------------------
  app.get('/api/admin/kb', async () => ({ entries: listKb(true) }));

  app.post('/api/admin/kb', async (request, reply) => {
    const body = (request.body ?? {}) as Parameters<typeof upsertKb>[0] & { delete_id?: number };
    const identity = identityOf(request);

    if (body.delete_id) {
      deleteKb(body.delete_id, identity.user);
      return { ok: true, deleted: body.delete_id };
    }
    if (!body.topic) return reply.code(400).send({ error: 'topic is required' });

    const entry = upsertKb({ ...body, actor: identity.user });
    if (entry.approved) {
      // Only approved entries enter the retrieval index.
      reindexKbEntry(entry).catch((err) => request.log.warn({ err }, 'KB embedding failed'));
    }
    return { ok: true, entry };
  });

  app.get('/api/admin/kb/:id/history', async (request) => {
    const params = request.params as { id: string };
    return { entry: getKbEntry(Number(params.id)), audit: auditTrail('kb', params.id, 50) };
  });

  // --- Escalation log -------------------------------------------------------
  app.get('/api/admin/escalations', async (request) => {
    const q = request.query as { status?: string; urgency?: string; limit?: string; offset?: string };
    return {
      rows: listEscalations({
        status: q.status,
        urgency: q.urgency,
        limit: Number(q.limit ?? 50),
        offset: Number(q.offset ?? 0),
      }),
    };
  });

  app.post('/api/admin/escalations/:id/resolve', async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { note?: string };
    resolveEscalation(Number(params.id), body.note ?? '', identityOf(request).user);
    return { ok: true };
  });

  // --- Analytics ------------------------------------------------------------
  app.get('/api/admin/analytics', async (request) => {
    const q = request.query as { days?: string };
    return kpiSummary(Number(q.days ?? 30));
  });

  // --- Business settings ----------------------------------------------------
  app.get('/api/admin/settings', async () => ({
    settings: getSettings(),
    missing: missingSettings(),
  }));

  app.post('/api/admin/settings', async (request) => {
    const body = (request.body ?? {}) as Partial<Record<SettingKey, string | null>>;
    const settings = setSettings(body, identityOf(request).user);
    return { ok: true, settings, missing: missingSettings() };
  });

  // --- Questionnaire config -------------------------------------------------
  app.get('/api/admin/questionnaires', async () => ({ questionnaires: loadAllQuestionnaires() }));

  app.post('/api/admin/questionnaires/:id', async (request, reply) => {
    const params = request.params as { id: QuestionnaireId };
    const problems = saveQuestionnaire(params.id, request.body as never);
    if (problems.length) return reply.code(400).send({ error: 'Validation failed', problems });
    return { ok: true };
  });

  // --- Catalogue import (spec: no REST pull — the site pushes a file) -------
  //
  // Replaces the old /api/admin/sync, which pulled the whole catalogue over
  // the WooCommerce REST API. On constrained hosting that pull, stacked on top
  // of the per-product webhook push that was already happening, meant every
  // edit cost two full WordPress + WooCommerce boots. Import instead accepts
  // data the site (or a local file, via `npm run import:prod`) sends it.
  //
  // Two calls: POST chunks of products to /import, then one call to /finish to
  // rebuild the search index and, optionally, prune anything not in the file.
  app.post(
    '/api/admin/catalogue/import',
    { bodyLimit: 10 * 1024 * 1024 },
    async (request, reply) => {
      const body = (request.body ?? {}) as { products?: WooRawProduct[] };
      if (!Array.isArray(body.products) || body.products.length === 0) {
        return reply.code(400).send({ error: 'products must be a non-empty array' });
      }

      let upserted = 0;
      for (const product of body.products) {
        if (!product.id || !product.name) continue;
        upsertWooFields(normalizeWooProduct(product));
        upserted += 1;
      }

      return { ok: true, upserted, skipped: body.products.length - upserted };
    },
  );

  // Also doubles as the WP dashboard's standalone "run labeling now" action:
  // called with just { label: true, limit } and no product_ids/prune, this
  // runs a labeling batch against the existing catalogue with no import
  // involved at all — the same thing `npm run label:prod -- --limit N` does
  // from the backend's own terminal, just triggered from wp-admin instead.
  app.post('/api/admin/catalogue/finish', async (request) => {
    const body = (request.body ?? {}) as {
      reindex?: boolean;
      label?: boolean;
      limit?: number;
      prune?: boolean;
      product_ids?: number[];
    };
    const result: Record<string, unknown> = {};

    if (body.prune) {
      // Anything in the local mirror that wasn't in the uploaded file has
      // presumably been deleted or unpublished on the site since the last
      // import, and should stop being recommendable.
      const keep = new Set(body.product_ids ?? []);
      const toRemove = allProducts()
        .map((p) => p.product_id)
        .filter((id) => !keep.has(id));
      for (const id of toRemove) deleteProduct(id);
      result.pruned = toRemove.length;
    }

    if (body.reindex) result.embedded = await reindexProducts();
    if (body.label) result.labeling = await labelCatalogue({ limit: body.limit });

    request.log.info({ result }, 'Catalogue maintenance run finished (import/label/prune, as requested)');
    return { ok: true, ...result, products: countProducts() };
  });

  app.get('/api/admin/status', async () => ({
    products: countProducts(),
    vectors: vectorCount(),
    missing_settings: missingSettings(),
  }));

  // --- Version history ------------------------------------------------------
  app.get('/api/admin/audit', async (request) => {
    const q = request.query as { entity?: string; entity_id?: string; limit?: string };
    return { rows: auditTrail(q.entity, q.entity_id, Number(q.limit ?? 100)) };
  });
}
