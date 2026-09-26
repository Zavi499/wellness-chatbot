/**
 * Skin and hair analyzer endpoints (shortcode pages, not the chat widget).
 *
 * Deliberately thin. The analyzer is a different way to fill in a
 * `CustomerProfile` — the questionnaire, eligibility, scoring and card
 * building underneath are the same ones the chat uses, so a product can
 * never be recommendable in one surface and not the other.
 */
import type { FastifyInstance } from 'fastify';
import { ANALYZERS, isAnalyzerKind, type AnalyzerDefinition } from '../analyzer/config.js';
import { analyzePhoto, validateDataUrl } from '../analyzer/vision.js';
import { createSession, getSession, recordAnswer, saveSession } from '../chat/session.js';
import { nextQuestion, quickRepliesFor, promptFor } from '../questionnaire/engine.js';
import { buildProfile } from '../recommend/profile.js';
import { selectTopThree, toRecommendationSet } from '../recommend/select.js';
import { checkRateLimit, checkPhotoLimit } from '../security/ratelimit.js';
import { issueSessionToken, verifySessionToken } from '../security/hmac.js';
import { logEvent } from '../analytics/audit.js';
import { PRIVACY_NOTICE } from '../safety/templates.js';
import type { Language, SessionState } from '../types.js';

/** Photos arrive base64-in-JSON, so this route needs more than the 1MB global. */
const PHOTO_BODY_LIMIT = 4 * 1024 * 1024;

const STEP_OPTS = { includeOptional: true } as const;

const REFERRAL_NOTE: Record<Language, string> = {
  en: 'Something in your photo is better looked at by a person than by me. Please speak to one of our pharmacists or your doctor before starting anything new — I have not used the photo for the questions below.',
  ar: 'هناك ما يستحق أن يراه شخص مختص وليس أنا. يرجى التحدث إلى أحد الصيادلة لدينا أو إلى طبيبك قبل البدء بأي منتج جديد — لم أعتمد على الصورة في الأسئلة أدناه.',
};

interface Body {
  session_id?: string;
  token?: string;
}

/**
 * The shape every step returns, so the wizard has one thing to render.
 *
 * Persists unconditionally before returning, and is the single exit point of
 * every analyzer route for exactly that reason. `recordAnswer()` only mutates
 * the in-memory object — the chat gets away with that because its
 * orchestrator saves once at the end of a turn, but each analyzer step is its
 * own request. Saving on only some branches meant every intermediate answer
 * was dropped, and the wizard oscillated between the first two questions
 * forever instead of advancing.
 */
function stepPayload(def: AnalyzerDefinition, state: SessionState, language: Language) {
  const step = nextQuestion(def.questionnaire, state.answers, STEP_OPTS);

  if (!step.done && step.question) {
    saveSession(state);
    return {
      done: false as const,
      question: {
        key: step.question.key,
        text: promptFor(step.question, language),
        type: step.question.type,
        options: quickRepliesFor(step.question, language),
      },
      progress: { step: step.step, total: step.total },
    };
  }

  const profile = buildProfile(def.category, state.answers);
  const set = toRecommendationSet(selectTopThree(profile), language);
  state.last_recommendations = set.items.map((i) => i.product_id);
  saveSession(state);
  logEvent('analyzer_completed', state.session_id, {
    kind: def.kind,
    results: set.items.length,
  });

  return {
    done: true as const,
    progress: { step: step.total, total: step.total },
    recommendations: set,
  };
}

/** Shared guard: valid token, live session, known analyzer kind. */
function resolve(
  body: Body,
): { error: string; code: number } | { state: SessionState; def: AnalyzerDefinition; language: Language } {
  if (!body.session_id || !verifySessionToken(body.token ?? '', body.session_id)) {
    return { error: 'Invalid or expired session token', code: 401 };
  }
  const state = getSession(body.session_id);
  if (!state) return { error: 'Session not found or expired', code: 404 };

  const kind = state.answers.__analyzer_kind;
  if (typeof kind !== 'string' || !isAnalyzerKind(kind)) {
    return { error: 'This session is not an analyzer session', code: 400 };
  }
  return { state, def: ANALYZERS[kind], language: state.language ?? 'en' };
}

export async function analyzerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/analyzer/session', async (request, reply) => {
    const body = (request.body ?? {}) as { kind?: string; language?: Language };
    const rate = checkRateLimit(undefined, request.ip);
    if (!rate.allowed) return reply.code(429).send({ error: 'Too many requests', retry_after: rate.retryAfter });
    if (!isAnalyzerKind(body.kind)) return reply.code(400).send({ error: 'Unknown analyzer kind' });

    const def = ANALYZERS[body.kind];
    const language: Language = body.language === 'ar' ? 'ar' : 'en';
    const state = createSession();
    state.language = language;
    state.language_locked = true;
    // `help_topic` is what makes the existing questionnaire and profile code
    // work unchanged; `__analyzer_kind` is how later calls know which wizard
    // this session belongs to. Both are answers, so they survive in session
    // state without a schema change.
    state.answers.help_topic = def.category;
    state.answers.__analyzer_kind = def.kind;
    saveSession(state);
    logEvent('analyzer_started', state.session_id, { kind: def.kind });

    return {
      session_id: state.session_id,
      token: issueSessionToken(state.session_id),
      kind: def.kind,
      language,
      privacy_notice: PRIVACY_NOTICE[language],
      ...stepPayload(def, state, language),
    };
  });

  app.post('/api/analyzer/photo', { bodyLimit: PHOTO_BODY_LIMIT }, async (request, reply) => {
    const body = (request.body ?? {}) as Body & { image?: string };
    const resolved = resolve(body);
    if ('error' in resolved) return reply.code(resolved.code).send({ error: resolved.error });
    const { state, def, language } = resolved;

    const rate = checkPhotoLimit(state.session_id, request.ip);
    if (!rate.allowed) {
      return reply.code(429).send({ error: 'Too many photo checks', retry_after: rate.retryAfter });
    }

    const image = typeof body.image === 'string' ? body.image : '';
    const invalid = validateDataUrl(image);
    if (invalid) {
      logEvent('analyzer_photo_rejected', state.session_id, { kind: def.kind, reason: invalid });
      return reply.code(400).send({ error: invalid });
    }

    let reading;
    try {
      reading = await analyzePhoto(def, image, language);
    } catch (err) {
      // Most likely cause is a configured vision model that does not accept
      // images. Say so plainly rather than failing as a generic 500 — the
      // model is settable from wp-admin, so this is a fixable misconfiguration.
      console.error('[analyzer] vision call failed:', err);
      return reply.code(502).send({
        error: 'The photo could not be analysed. Check that the configured vision model supports images.',
      });
    }

    if (!reading.usable || reading.refer_to_professional) {
      logEvent('analyzer_photo_rejected', state.session_id, {
        kind: def.kind,
        reason: reading.refer_to_professional ? 'referred' : 'unusable',
      });
    } else {
      logEvent('analyzer_photo_analyzed', state.session_id, {
        kind: def.kind,
        prefilled: Object.keys(reading.suggested_answers).length,
      });
    }

    // Pre-fill only. Every suggested answer is shown pre-selected on its own
    // step, so the customer can change any of them before anything is
    // recommended.
    for (const [key, value] of Object.entries(reading.suggested_answers)) {
      recordAnswer(state, key, value);
    }
    saveSession(state);

    return {
      usable: reading.usable,
      unusable_reason: reading.unusable_reason,
      refer_to_professional: reading.refer_to_professional,
      referral_note: reading.refer_to_professional ? REFERRAL_NOTE[language] : null,
      summary: reading.refer_to_professional ? null : reading.summary,
      prefilled: Object.keys(reading.suggested_answers),
      ...stepPayload(def, state, language),
    };
  });

  app.post('/api/analyzer/answer', async (request, reply) => {
    const body = (request.body ?? {}) as Body & { key?: string; value?: string | string[]; clear?: boolean };
    const resolved = resolve(body);
    if ('error' in resolved) return reply.code(resolved.code).send({ error: resolved.error });
    const { state, def, language } = resolved;

    const rate = checkRateLimit(state.session_id, request.ip);
    if (!rate.allowed) return reply.code(429).send({ error: 'Too many requests', retry_after: rate.retryAfter });

    const key = typeof body.key === 'string' ? body.key : '';
    // `__`-prefixed keys and `help_topic` are internal bookkeeping, not
    // questions — letting a request rewrite them would let it move the
    // session to another shelf mid-flow.
    if (!key || key.startsWith('__') || key === 'help_topic') {
      return reply.code(400).send({ error: 'Unknown question' });
    }

    if (body.clear === true) {
      // Going back: drop the answer so the stepper offers that question again.
      delete state.answers[key];
      saveSession(state);
    } else {
      const value = body.value;
      const ok = typeof value === 'string' ? value !== '' : Array.isArray(value) && value.length > 0;
      if (!ok) return reply.code(400).send({ error: 'An answer is required' });
      recordAnswer(state, key, value as string | string[]);
    }

    return stepPayload(def, state, language);
  });
}
