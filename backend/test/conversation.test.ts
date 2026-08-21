/**
 * Questionnaire behaviour, bilingual handling and request signing
 * (spec §4.4, §6.1, §6.3, §11).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadQuestionnaire,
  loadAllQuestionnaires,
  validateQuestionnaire,
} from '../src/questionnaire/loader.js';
import { isApplicable, nextQuestion, pendingQuestions } from '../src/questionnaire/engine.js';
import { detectByScript } from '../src/language/detect.js';
import { expandQuery, normalizeArabic, normalizeQuery, keywordScore } from '../src/search/normalize.js';
import { sign, verifySignature, issueSessionToken, verifySessionToken } from '../src/security/hmac.js';
import { resolvePushedProducts } from '../src/routes/webhooks.js';
import { cosine } from '../src/search/vector.js';

describe('questionnaire config (§4.4)', () => {
  test('all five configs load and validate', () => {
    const all = loadAllQuestionnaires();
    for (const [id, cfg] of Object.entries(all)) {
      assert.deepEqual(validateQuestionnaire(cfg), [], `${id} should validate cleanly`);
    }
  });

  test('every question is bilingual with 3–7 options', () => {
    for (const cfg of Object.values(loadAllQuestionnaires())) {
      for (const q of cfg.questions) {
        assert.ok(q.text_en.trim(), `${q.key} needs English text`);
        assert.ok(q.text_ar.trim(), `${q.key} needs Arabic text`);
        assert.ok(q.options.length >= 3 && q.options.length <= 7, `${q.key} has ${q.options.length} options`);
      }
    }
  });

  test('knowledge questions always offer "I\'m not sure"', () => {
    for (const cfg of Object.values(loadAllQuestionnaires())) {
      for (const q of cfg.questions.filter((x) => x.knowledge_question)) {
        assert.ok(
          q.options.some((o) => o.value === 'not_sure'),
          `${q.key} assumes product knowledge but offers no escape hatch`,
        );
      }
    }
  });

  test('validation rejects a non-compliant edit', () => {
    const broken = {
      id: 'test',
      title_en: 'Test',
      title_ar: 'اختبار',
      questions: [
        {
          key: 'skin_type',
          text_en: 'Your skin type?',
          text_ar: '',
          type: 'single' as const,
          knowledge_question: true,
          options: [{ value: 'oily', label_en: 'Oily', label_ar: 'دهنية' }],
        },
      ],
    };
    const problems = validateQuestionnaire(broken);
    assert.ok(problems.some((p) => /Arabic text/.test(p)));
    assert.ok(problems.some((p) => /at least 3/.test(p)));
    assert.ok(problems.some((p) => /not_sure/.test(p)));
  });
});

describe('never repeat an answered question (§4.1)', () => {
  test('an answered question drops out of the pending list', () => {
    const cfg = loadQuestionnaire('face');
    const before = pendingQuestions(cfg, {});
    const after = pendingQuestions(cfg, { product_type: 'moisturizer' });

    assert.ok(before.some((q) => q.key === 'product_type'));
    assert.ok(!after.some((q) => q.key === 'product_type'), 'product_type must not be asked again');
  });

  test('nextQuestion advances and reports progress', () => {
    const first = nextQuestion('face', {});
    assert.equal(first.question?.key, 'product_type');
    assert.equal(first.step, 1);
    assert.ok(first.total > 1);

    const second = nextQuestion('face', { product_type: 'moisturizer' });
    assert.notEqual(second.question?.key, 'product_type');
    assert.equal(second.step, 2);
  });

  test('the flow reports done once everything applicable is answered', () => {
    const cfg = loadQuestionnaire('body');
    const answers: Record<string, string> = {};
    for (const q of cfg.questions.filter((x) => !x.optional)) {
      answers[q.key] = q.options[0]!.value;
    }
    assert.equal(nextQuestion('body', answers).done, true);
  });
});

describe('branch questions (§4.4)', () => {
  test('cleanser follow-ups only appear for a cleanser', () => {
    const cfg = loadQuestionnaire('face');
    const tightness = cfg.questions.find((q) => q.key === 'cleanser_tightness')!;

    assert.equal(isApplicable(tightness, { product_type: 'moisturizer' }), false);
    assert.equal(isApplicable(tightness, { product_type: 'cleanser' }), true);
  });

  test('sunscreen follow-ups only appear for a sunscreen', () => {
    const cfg = loadQuestionnaire('face');
    const tint = cfg.questions.find((q) => q.key === 'sunscreen_tint')!;

    assert.equal(isApplicable(tint, { product_type: 'cleanser' }), false);
    assert.equal(isApplicable(tint, { product_type: 'sunscreen' }), true);
  });

  test('hair-loss follow-ups only appear when hair loss is the concern', () => {
    const cfg = loadQuestionnaire('hair');
    const duration = cfg.questions.find((q) => q.key === 'hair_loss_duration')!;

    assert.equal(isApplicable(duration, { concern_primary: 'dandruff' }), false);
    assert.equal(isApplicable(duration, { concern_primary: 'hair_loss' }), true);
  });
});

describe('language detection (§6.1)', () => {
  test('detects English and Arabic from script', () => {
    assert.equal(detectByScript('do you have a moisturiser').language, 'en');
    assert.equal(detectByScript('هل يوجد مرطب للبشرة الجافة').language, 'ar');
  });

  test('an Arabic sentence containing a Latin brand name is still Arabic', () => {
    assert.equal(detectByScript('أبحث عن غسول من CeraVe للبشرة الدهنية').language, 'ar');
  });

  test('genuinely mixed input is reported as ambiguous, not guessed', () => {
    assert.equal(detectByScript('hello مرحبا').language, null);
  });
});

describe('search normalization (§6.3)', () => {
  test('folds Arabic orthography variants', () => {
    assert.equal(normalizeArabic('واقى'), normalizeArabic('واقي'));
    assert.equal(normalizeArabic('أحمر'), normalizeArabic('احمر'));
  });

  test('converts Arabic-Indic digits', () => {
    assert.equal(normalizeQuery('٥٠ مل'), '50 مل');
  });

  test('sunscreen synonyms resolve across both languages', () => {
    for (const query of ['sunblock', 'SPF 50', 'واقي شمس', 'صن بلوك']) {
      assert.ok(
        expandQuery(query).concepts.includes('sunscreen'),
        `"${query}" should resolve to the sunscreen concept`,
      );
    }
  });

  test('acne synonyms resolve across both languages', () => {
    for (const query of ['pimples', 'breakouts', 'حب الشباب', 'حبوب']) {
      assert.ok(expandQuery(query).concepts.includes('acne'), `"${query}" should resolve to acne`);
    }
  });

  test('phonetic brand spellings resolve to one brand', () => {
    for (const query of ['la roche posay', 'La Roche', 'لاروش', 'لاروش بوزيه']) {
      assert.ok(expandQuery(query).concepts.includes('la_roche_posay'), `"${query}" should resolve`);
    }
  });

  test('keyword scoring prefers the matching product text', () => {
    const query = expandQuery('sunblock for oily skin');
    const relevant = keywordScore(query, 'Sunscreen SPF 50 for oily skin, matte finish');
    const irrelevant = keywordScore(query, 'Nourishing hair mask for dry ends');
    assert.ok(relevant > irrelevant);
  });
});

describe('product push validation (no REST fallback)', () => {
  test('a batch payload resolves to its products array', () => {
    const products = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
    assert.deepEqual(resolvePushedProducts({ action: 'updated', products } as never), products);
  });

  test('a single inlined product resolves to a one-item array', () => {
    const result = resolvePushedProducts({ action: 'updated', id: 5, name: 'Solo product' } as never);
    assert.deepEqual(result, [{ action: 'updated', id: 5, name: 'Solo product' }]);
  });

  test('an id with no product data is rejected, not treated as a reason to fetch', () => {
    assert.equal(resolvePushedProducts({ action: 'updated', id: 42 } as never), null);
  });

  test('an empty products array is rejected', () => {
    assert.equal(resolvePushedProducts({ action: 'updated', products: [] } as never), null);
  });

  test('an entirely empty body is rejected', () => {
    assert.equal(resolvePushedProducts({} as never), null);
  });
});

describe('request signing (§11)', () => {
  const secret = 'test-secret-value';

  test('a correctly signed request verifies', () => {
    const body = JSON.stringify({ hello: 'world' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    assert.equal(verifySignature(body, timestamp, sign(body, timestamp, secret), secret).ok, true);
  });

  test('a tampered body fails', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(JSON.stringify({ amount: 1 }), timestamp, secret);
    assert.equal(verifySignature(JSON.stringify({ amount: 999 }), timestamp, signature, secret).ok, false);
  });

  test('a replayed old request fails', () => {
    const body = '{}';
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    assert.equal(verifySignature(body, old, sign(body, old, secret), secret).ok, false);
  });

  test('a missing signature fails', () => {
    assert.equal(verifySignature('{}', String(Date.now() / 1000), undefined, secret).ok, false);
  });

  test('session tokens are bound to their session', () => {
    process.env.WP_SHARED_SECRET = secret;
    const token = issueSessionToken('session-a');
    assert.equal(verifySessionToken(token, 'session-b'), false, 'a token must not work for another session');
  });
});

describe('vector maths', () => {
  test('cosine similarity behaves', () => {
    assert.equal(Math.round(cosine([1, 0], [1, 0]) * 100) / 100, 1);
    assert.equal(Math.round(cosine([1, 0], [0, 1]) * 100) / 100, 0);
    assert.ok(cosine([1, 1], [1, 0.9]) > cosine([1, 1], [1, 0.1]));
  });
});
