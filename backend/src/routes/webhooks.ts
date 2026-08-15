/**
 * Product push receiver (spec §10, §11).
 *
 * WordPress pushes here — the backend never calls back into the website.
 * The plugin's queue POSTs a batch of full product payloads on save (so a
 * bulk edit collapses into a handful of requests instead of one per product),
 * plus small immediate pushes for stock changes and deletions. Every shape is
 * HMAC-verified before anything is written.
 *
 * There used to be a fallback here that pulled a product over the WooCommerce
 * REST API when a payload carried only an id. That fallback is gone: it meant
 * every push cost a second full WordPress + WooCommerce boot to service the
 * pull, which is exactly the load this endpoint exists to avoid. A payload
 * with no product data is now a 400, not a reason to call the site.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { verifyWooWebhook, verifySignature } from '../security/hmac.js';
import { normalizeWooProduct, type WooRawProduct } from '../products/normalize.js';
import { deleteProduct, getProduct, setStockStatus, upsertWooFields } from '../products/repository.js';
import { reindexProduct } from '../search/embeddings.js';
import { labelProduct } from '../labeling/pipeline.js';

export interface PushBody {
  action?: 'updated' | 'deleted' | 'stock_changed';
  id?: number;
  stock_status?: string;
  relabel?: boolean;
  /** A single product's full data. */
  name?: string;
  /** A batch of products' full data — how the plugin's queue actually sends things. */
  products?: WooRawProduct[];
}

/**
 * Resolves the product data out of an 'updated' push body — either a batch
 * (`products`) or a single product's fields inlined on the body itself.
 * Returns `null` when there is no actual product data, which the route turns
 * into a 400. This is the guard that replaced the old REST fallback: a
 * payload that names a product without describing it is rejected rather than
 * being treated as a reason to go fetch it.
 */
export function resolvePushedProducts(body: PushBody): WooRawProduct[] | null {
  if (Array.isArray(body.products)) {
    return body.products.length > 0 ? body.products : null;
  }
  if (body.name) {
    return [body as WooRawProduct];
  }
  return null;
}

/** Upserts one product, then re-embeds and optionally re-labels it. */
function applyProduct(
  raw: WooRawProduct,
  relabel: boolean,
  log: { warn: (obj: unknown, msg: string) => void },
): void {
  upsertWooFields(normalizeWooProduct(raw));

  const product = getProduct(raw.id);
  if (!product) return;

  // Re-embed so search reflects the edit. Labeling is opt-in per push so a
  // bulk price update does not trigger a catalogue-wide model spend.
  reindexProduct(product).catch((err) => log.warn({ err }, 'Re-embedding failed'));
  if (relabel && product.verification_status !== 'verified') {
    labelProduct(product.product_id).catch((err) => log.warn({ err }, 'Auto-labeling failed'));
  }
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/webhooks/woocommerce/product', async (request, reply) => {
    const raw = (request as { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {});

    // Accept either a native WooCommerce webhook signature or our plugin's own
    // signed push. Both are pushes — neither triggers a call back to the site.
    const wooSignature = request.headers['x-wc-webhook-signature'] as string | undefined;
    const pluginSignature = request.headers['x-wellness-signature'] as string | undefined;
    const pluginTimestamp = request.headers['x-wellness-timestamp'] as string | undefined;

    const wooOk = wooSignature
      ? verifyWooWebhook(raw, wooSignature, config.wordpress.sharedSecret)
      : false;
    const pluginOk = pluginSignature ? verifySignature(raw, pluginTimestamp, pluginSignature).ok : false;

    if (!wooOk && !pluginOk) {
      request.log.warn('Rejected an unsigned or badly signed product push');
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    const body = (request.body ?? {}) as PushBody;
    const action = body.action ?? 'updated';
    const relabel = Boolean(body.relabel);

    if (action === 'deleted') {
      if (!body.id) return reply.code(400).send({ error: 'Payload has no product id' });
      deleteProduct(body.id);
      return { ok: true, action, product_id: body.id };
    }

    if (action === 'stock_changed') {
      if (!body.id) return reply.code(400).send({ error: 'Payload has no product id' });
      if (!body.stock_status) return reply.code(400).send({ error: 'Payload has no stock_status' });
      const status =
        body.stock_status === 'outofstock' || body.stock_status === 'onbackorder'
          ? body.stock_status
          : 'instock';
      setStockStatus(body.id, status);
      return { ok: true, action, product_id: body.id, stock_status: status };
    }

    // action === 'updated' — a batch, or a single product, of full data.
    const products = resolvePushedProducts(body);

    if (!products) {
      return reply.code(400).send({
        error: 'No product data in the payload. This endpoint accepts pushed product data — it does not pull from the site.',
      });
    }

    for (const product of products) {
      if (!product.id || !product.name) continue;
      applyProduct(product, relabel, request.log);
    }

    return { ok: true, action, count: products.length };
  });
}
