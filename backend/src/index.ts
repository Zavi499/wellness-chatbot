/**
 * Fastify server entry point.
 *
 * Deliberately a long-running process, not serverless: session state and the
 * in-memory vector index both want a warm instance (spec §2).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { db } from './db/index.js';
import { chatRoutes } from './routes/chat.js';
import { adminRoutes } from './routes/admin.js';
import { webhookRoutes } from './routes/webhooks.js';
import { pruneExpiredSessions } from './chat/session.js';
import { pruneRateLimitBuckets } from './security/ratelimit.js';
import { missingSettings } from './settings/repository.js';
import { countProducts } from './products/repository.js';

export async function buildServer() {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 1_000_000,
    trustProxy: true,
  });

  // Keep the raw body so HMAC signatures verify byte-for-byte.
  app.addHook('preParsing', async (request, _reply, payload) => {
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    const raw = Buffer.concat(chunks);
    (request as { rawBody?: string }).rawBody = raw.toString('utf8');
    const { Readable } = await import('node:stream');
    return Readable.from(raw);
  });

  await app.register(cors, {
    // The widget reaches this service through the WordPress proxy, so only the
    // store's own origin ever needs to be allowed.
    origin: config.wordpress.baseUrl ? [config.wordpress.baseUrl] : false,
    methods: ['GET', 'POST'],
  });

  app.get('/health', async () => {
    const products = countProducts();
    return {
      status: 'ok',
      env: config.env,
      models: {
        chat: config.openai.chatModel,
        cheap: config.openai.cheapModel,
        label: config.openai.labelModel,
        embed: config.openai.embedModel,
      },
      products,
      missing_settings: missingSettings(),
    };
  });

  await app.register(chatRoutes);
  await app.register(adminRoutes);
  await app.register(webhookRoutes);

  return app;
}

async function main(): Promise<void> {
  db(); // run migrations before accepting traffic

  const app = await buildServer();

  const cleanup = setInterval(() => {
    const pruned = pruneExpiredSessions();
    pruneRateLimitBuckets();
    if (pruned > 0) app.log.debug(`Pruned ${pruned} expired sessions`);
  }, 5 * 60_000);
  cleanup.unref();

  await app.listen({ port: config.server.port, host: config.server.host });

  const missing = missingSettings();
  if (missing.length) {
    app.log.warn(
      `${missing.length} business settings are still unconfirmed (${missing.join(', ')}). ` +
        'The assistant will refuse to state these facts until they are filled in on the WordPress Business Settings screen.',
    );
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.log.info(`${signal} received, shutting down`);
      app.close().then(() => process.exit(0));
    });
  }
}

// Only start a server when run directly; tests import `buildServer` instead.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    console.error('Failed to start the Wellness World chatbot backend:', err);
    process.exit(1);
  });
}
