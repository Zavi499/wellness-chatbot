/**
 * Customer-facing endpoints (spec §10).
 *
 * These are reached only through the WordPress REST proxy, which signs each
 * request. The browser never talks to this service directly with a raw secret.
 */
import type { FastifyInstance } from 'fastify';
import { handleTurn } from '../chat/orchestrator.js';
import { createSession, getSession } from '../chat/session.js';
import { loadAllQuestionnaires } from '../questionnaire/loader.js';
import { checkRateLimit } from '../security/ratelimit.js';
import { issueSessionToken, verifySessionToken } from '../security/hmac.js';
import { db, nowIso } from '../db/index.js';
import { logEvent, type EventName } from '../analytics/audit.js';
import { PRIVACY_NOTICE, GREETING } from '../safety/templates.js';
import { getSettings } from '../settings/repository.js';
import type { Language } from '../types.js';

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/chat/session', async (request, reply) => {
    const body = (request.body ?? {}) as { language?: Language };
    const rate = checkRateLimit(undefined, request.ip);
    if (!rate.allowed) return reply.code(429).send({ error: 'Too many requests', retry_after: rate.retryAfter });

    const session = createSession();
    const language: Language = body.language === 'ar' ? 'ar' : 'en';

    return {
      session_id: session.session_id,
      token: issueSessionToken(session.session_id),
      language,
      greeting: GREETING[language],
      privacy_notice: PRIVACY_NOTICE[language],
      settings: {
        // Only the facts the widget itself needs to render.
        whatsapp_configured: Boolean(getSettings().whatsapp_number),
        currency: getSettings().currency,
      },
    };
  });

  app.post('/api/chat/message', async (request, reply) => {
    const body = (request.body ?? {}) as {
      session_id?: string;
      message?: string;
      token?: string;
      answer?: { key: string; value: string | string[] };
    };

    const rate = checkRateLimit(body.session_id, request.ip);
    if (!rate.allowed) return reply.code(429).send({ error: 'Too many requests', retry_after: rate.retryAfter });

    if (body.session_id && !verifySessionToken(body.token, body.session_id)) {
      return reply.code(401).send({ error: 'Invalid or expired session token' });
    }

    if (typeof body.message !== 'string') {
      return reply.code(400).send({ error: 'message is required' });
    }

    const response = await handleTurn({
      session_id: body.session_id ?? null,
      message: body.message,
      answer: body.answer,
    });
    return response;
  });

  app.get('/api/questionnaire/config', async () => {
    return { questionnaires: loadAllQuestionnaires() };
  });

  app.post('/api/feedback', async (request, reply) => {
    const body = (request.body ?? {}) as {
      session_id?: string;
      message_id?: string;
      rating?: 'up' | 'down';
      reason?: string;
      token?: string;
    };

    if (!body.session_id || !body.message_id || (body.rating !== 'up' && body.rating !== 'down')) {
      return reply.code(400).send({ error: 'session_id, message_id and rating are required' });
    }
    if (!verifySessionToken(body.token, body.session_id)) {
      return reply.code(401).send({ error: 'Invalid or expired session token' });
    }

    db()
      .prepare(
        `INSERT INTO feedback (session_id, message_id, rating, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(body.session_id, body.message_id, body.rating, body.reason ?? null, nowIso());

    logEvent(body.rating === 'up' ? 'feedback_up' : 'feedback_down', body.session_id, {
      message_id: body.message_id,
      reason: body.reason ?? null,
    });

    return { ok: true };
  });

  /** Card interactions the widget reports back so the KPIs in §14 can be built. */
  app.post('/api/chat/event', async (request, reply) => {
    const body = (request.body ?? {}) as {
      session_id?: string;
      token?: string;
      name?: string;
      payload?: unknown;
    };

    const allowed: EventName[] = [
      'recommendation_view_product',
      'recommendation_compare',
      'recommendation_add_to_cart',
      'recommendation_replace',
      'routine_built',
      'questionnaire_started',
    ];

    if (!body.session_id || !allowed.includes(body.name as EventName)) {
      return reply.code(400).send({ error: 'Unknown or missing event' });
    }
    if (!verifySessionToken(body.token, body.session_id)) {
      return reply.code(401).send({ error: 'Invalid or expired session token' });
    }
    if (!getSession(body.session_id)) {
      return reply.code(404).send({ error: 'Session not found or expired' });
    }

    logEvent(body.name as EventName, body.session_id, body.payload ?? null);
    return { ok: true };
  });
}
