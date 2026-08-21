/**
 * Knowledge base direct-answer behaviour (spec §7) — by explicit store-owner
 * decision, an entry goes live the moment both languages have an answer, no
 * separate approval step. The one gate that remains is completeness, not
 * review.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/db/index.js';
import { upsertKb, listKb } from '../src/kb/repository.js';

describe('upsertKb: direct answers, no approval input', () => {
  test('an entry with both languages is immediately live', () => {
    const conn = openMemoryDb();
    const entry = upsertKb(
      {
        topic: 'delivery',
        question_en: 'Do you deliver?',
        question_ar: 'هل توصلون؟',
        answer_en: 'Yes, across Kuwait.',
        answer_ar: 'نعم، في جميع أنحاء الكويت.',
        actor: 'tester',
      },
      conn,
    );

    assert.equal(entry.approved, true);
    assert.ok(listKb(false, conn).some((e) => e.id === entry.id), 'a complete entry must be immediately searchable');
  });

  test('an entry missing one language is not live', () => {
    const conn = openMemoryDb();
    const entry = upsertKb(
      { topic: 'returns', answer_en: 'Yes, within 7 days.', answer_ar: null, actor: 'tester' },
      conn,
    );

    assert.equal(entry.approved, false);
    assert.equal(
      listKb(false, conn).some((e) => e.id === entry.id),
      false,
      'an incomplete entry must never be usable',
    );
  });

  test('editing an incomplete entry to add the missing language makes it live immediately', () => {
    const conn = openMemoryDb();
    const draft = upsertKb({ topic: 'payment', answer_en: 'KNET and cards.', answer_ar: null, actor: 'tester' }, conn);
    assert.equal(draft.approved, false);

    const completed = upsertKb(
      { id: draft.id, topic: 'payment', answer_en: 'KNET and cards.', answer_ar: 'كي نت والبطاقات.', actor: 'tester' },
      conn,
    );

    assert.equal(completed.approved, true);
    assert.ok(listKb(false, conn).some((e) => e.id === draft.id));
  });

  test('a legacy row with a stale approved=0 but both answers filled is still served', () => {
    // Simulates a row saved before direct-answer behaviour shipped, where the
    // stored `approved` column never got flipped — listKb(false) must not
    // trust that column, only the actual answer completeness.
    const conn = openMemoryDb();
    const result = conn
      .prepare(
        `INSERT INTO kb_entries (topic, answer_en, answer_ar, approved, updated_at)
         VALUES (?, ?, ?, 0, datetime('now'))`,
      )
      .run('loyalty', 'Yes.', 'نعم.');
    const id = Number(result.lastInsertRowid);

    const live = listKb(false, conn).find((e) => e.id === id);
    assert.ok(live, 'completeness, not the stored flag, decides usability');
    assert.equal(live!.approved, true, 'the returned entry reports itself as usable');
  });

  test('listKb(true) still returns incomplete entries, for the admin screen', () => {
    const conn = openMemoryDb();
    const draft = upsertKb({ topic: 'hours', answer_en: null, answer_ar: null, actor: 'tester' }, conn);

    assert.ok(listKb(true, conn).some((e) => e.id === draft.id));
    assert.equal(listKb(false, conn).some((e) => e.id === draft.id), false);
  });
});
