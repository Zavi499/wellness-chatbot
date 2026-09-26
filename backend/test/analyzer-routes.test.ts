/**
 * End-to-end walk of the analyzer routes through Fastify's inject(), with no
 * network and no OpenAI call (the photo step is the only thing that would
 * reach the API, and it is not exercised here).
 *
 * This exists because of a specific bug: `recordAnswer()` mutates the session
 * in memory but does not persist it, and the answer route only saved on the
 * final step. Every intermediate answer was dropped, so the wizard bounced
 * between the first two questions forever. Unit tests over `nextQuestion()`
 * all passed — the fault was only visible across two requests, which is what
 * this file covers.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A throwaway database per run: these routes use the real db() singleton, and
// a test must never write into the working catalogue.
const tmpDb = path.join(os.tmpdir(), `wwc-analyzer-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDb;
process.env.WP_SHARED_SECRET = 'test-secret-for-session-tokens';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-key-unused';

const { buildServer } = await import('../src/index.js');

let app: Awaited<ReturnType<typeof buildServer>>;

before(async () => {
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(tmpDb + suffix);
    } catch {
      /* already gone */
    }
  }
});

async function startSession(kind: 'skin' | 'hair') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/analyzer/session',
    payload: { kind, language: 'en' },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

function answer(session: { session_id: string; token: string }, key: string, value: string) {
  return app.inject({
    method: 'POST',
    url: '/api/analyzer/answer',
    payload: { session_id: session.session_id, token: session.token, key, value },
  });
}

describe('analyzer routes', () => {
  test('a session starts on the first question', async () => {
    const session = await startSession('skin');
    assert.ok(session.session_id);
    assert.ok(session.token);
    assert.equal(session.done, false);
    assert.equal(session.question.key, 'product_type');
    assert.ok(session.question.options.length > 0);
    assert.ok(session.progress.total > 1);
  });

  test('answering advances, and never returns a question already answered', async () => {
    const session = await startSession('skin');

    const asked: string[] = [];
    let step = session;

    // Walk the whole wizard, always taking the first option.
    for (let i = 0; i < 25 && !step.done; i++) {
      assert.ok(
        !asked.includes(step.question.key),
        `"${step.question.key}" was asked twice — answers are not persisting between requests`,
      );
      asked.push(step.question.key);

      const res = await answer(session, step.question.key, step.question.options[0].value);
      assert.equal(res.statusCode, 200, res.body);
      step = res.json();
    }

    assert.ok(step.done, 'the wizard never reached the end');
    assert.ok(asked.length >= 3, `only reached ${asked.length} question(s): ${asked.join(', ')}`);
    assert.ok(step.recommendations, 'a finished wizard must return a recommendation set');
  });

  test('an answer survives into the next request', async () => {
    const session = await startSession('skin');
    const first = session.question.key;
    const chosen = session.question.options[0].value;

    await answer(session, first, chosen);
    // A second, unrelated call must still see the first answer as recorded.
    const res = await answer(session, 'sensitivity_level', 'somewhat');
    const step = res.json();

    assert.notEqual(step.question?.key, first, 'the first question came back — it was not persisted');
  });

  test('Back clears an answer and offers that question again', async () => {
    const session = await startSession('skin');
    const first = session.question.key;

    const afterAnswer = (await answer(session, first, session.question.options[0].value)).json();
    assert.notEqual(afterAnswer.question.key, first);

    const res = await app.inject({
      method: 'POST',
      url: '/api/analyzer/answer',
      payload: { session_id: session.session_id, token: session.token, key: first, clear: true },
    });
    assert.equal(res.json().question.key, first, 'clearing should re-offer the question');
  });

  test('the hair analyzer runs its own questionnaire', async () => {
    const session = await startSession('hair');
    assert.equal(session.kind, 'hair');
    const res = await answer(session, session.question.key, session.question.options[0].value);
    assert.equal(res.statusCode, 200);
  });

  test('a bad token is rejected', async () => {
    const session = await startSession('skin');
    const res = await app.inject({
      method: 'POST',
      url: '/api/analyzer/answer',
      payload: { session_id: session.session_id, token: 'forged', key: 'skin_type', value: 'oily' },
    });
    assert.equal(res.statusCode, 401);
  });

  test('internal bookkeeping keys cannot be rewritten by a request', async () => {
    const session = await startSession('skin');
    for (const key of ['help_topic', '__analyzer_kind']) {
      const res = await answer(session, key, 'hair');
      assert.equal(res.statusCode, 400, `${key} must not be settable`);
    }
  });

  test('an unknown analyzer kind is refused', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/analyzer/session',
      payload: { kind: 'teeth' },
    });
    assert.equal(res.statusCode, 400);
  });
});
