/**
 * WooCommerce webhook receiver (spec §10, §11).
 *
 * WordPress fires these on product create/update/delete/stock-change. Payloads
 * are HMAC-verified before anything is written.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { verifyWooWebhook, verifySignature } from '../security/hmac.js';
import { normalizeWooProduct, syncSingleProduct, type WooRawProduct } from '../products/woocommerce.js';
import { deleteProduct, getProduct, setStockStatus, upsertWooFields } from '../products/repository.js';
import { reindexProduct } from '../search/embeddings.js';
import { labelProduct } from '../labeling/pipeline.js';

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/webhooks/woocommerce/product', async (request, reply) => {
    const raw = (request as { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {});

    // Accept either a WooCommerce-native signature or our plugin's signed call.
    const wooSignature = request.headers['x-wc-webhook-signature'] as string | undefined;
    const pluginSignature = request.headers['x-wellness-signature'] as string | undefined;
    const pluginTimestamp = request.headers['x-wellness-timestamp'] as string | undefined;

    const wooOk = wooSignature
      ? verifyWooWebhook(raw, wooSignature, config.wordpress.sharedSecret)
      : false;
    const pluginOk = pluginSignature ? verifySignature(raw, pluginTimestamp, pluginSignature).ok : false;

    if (!wooOk && !pluginOk) {
      request.log.warn('Rejected an unsigned or badly signed product webhook');
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    const body = (request.body ?? {}) as Partial<WooRawProduct> & {
      action?: string;
      stock_status?: string;
      relabel?: boolean;
    };

    if (!body.id) return reply.code(400).send({ error: 'Payload has no product id' });

    const action = body.action ?? 'updated';

    if (action === 'deleted') {
      deleteProduct(body.id);
      return { ok: true, action, product_id: body.id };
    }

    if (action === 'stock_changed' && body.stock_status) {
      const status =
        body.stock_status === 'outofstock' || body.stock_status === 'onbackorder'
          ? body.stock_status
          : 'instock';
      setStockStatus(body.id, status);
      return { ok: true, action, product_id: body.id, stock_status: status };
    }

    // Full upsert. Prefer the payload we were sent; fall back to a REST pull
    // when the webhook carried only an id.
    try {
      if (body.name) {
        upsertWooFields(normalizeWooProduct(body as WooRawProduct));
      } else {
        await syncSingleProduct(body.id);
      }
    } catch (err) {
      request.log.error({ err }, 'Product sync failed');
      return reply.code(502).send({ error: 'Could not sync the product from WooCommerce' });
    }

    // Re-embed so search reflects the edit. Labeling is opt-in per webhook so a
    // bulk price update does not trigger a catalogue-wide model spend.
    const product = getProduct(body.id);
    if (product) {
      reindexProduct(product).catch((err) => request.log.warn({ err }, 'Re-embedding failed'));
      if (body.relabel && product.verification_status !== 'verified') {
        labelProduct(product.product_id).catch((err) => request.log.warn({ err }, 'Auto-labeling failed'));
      }
    }

    return { ok: true, action, product_id: body.id };
  });
}
