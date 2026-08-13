/**
 * Safety trigger tests (spec §5.1, §5.2, §15 phase 7).
 *
 * These are the tests that matter most: every trigger in Section 5 has to fire
 * in both English and Arabic, and an emergency must outrank everything else.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectTriggers, highestUrgency, EMERGENCY_RULES, PHARMACIST_RULES } from '../src/safety/triggers.js';
import { containsSensitiveData } from '../src/safety/engine.js';
import { evaluatePharmacistGate } from '../src/labeling/gate.js';

function urgencyOf(message: string) {
  return highestUrgency(detectTriggers(message));
}

describe('emergency triggers (§5.1)', () => {
  const cases: [string, string][] = [
    ['breathing', "I used the mask and now I can't breathe properly"],
    ['swelling', 'my face is swelling up after the cream'],
    ['anaphylaxis', 'I think I am having a severe allergic reaction'],
    ['fainting', 'she fainted after taking it'],
    ['chest pain', 'I have chest pain right now'],
    ['stroke', 'my speech is slurred and my arm went numb suddenly'],
    ['bleeding', 'the cut is bleeding heavily and it will not stop'],
    ['poisoning', 'my son swallowed a whole bottle of the tablets'],
    ['eye', 'severe eye pain since the serum went in'],
    ['chemical', 'chemical burn from the peel'],
    ['rash with fever', 'blistering rash all over with a fever'],
    ['unwell child', 'my baby is limp and not breathing well'],
  ];

  for (const [name, message] of cases) {
    test(`fires for ${name}`, () => {
      assert.equal(urgencyOf(message), 'emergency', `expected emergency for: ${message}`);
    });
  }

  test('fires on Arabic input too', () => {
    const arabic = [
      'لا استطيع التنفس بعد استخدام الكريم',
      'تورم في الوجه واللسان',
      'ألم في الصدر',
      'ابني بلع الدواء كامل',
      'نزيف شديد لا يتوقف',
    ];
    for (const message of arabic) {
      assert.equal(urgencyOf(message), 'emergency', `expected emergency for: ${message}`);
    }
  });

  test('every emergency rule has at least one Arabic pattern', () => {
    for (const rule of EMERGENCY_RULES) {
      const hasArabic = rule.patterns.some((p) => /[؀-ۿ]/.test(p.source));
      assert.ok(hasArabic, `rule "${rule.id}" has no Arabic pattern`);
    }
  });
});

describe('pharmacist-review triggers (§5.2)', () => {
  const cases: [string, string][] = [
    ['pregnancy', 'is this serum safe while pregnant?'],
    ['breastfeeding', 'can I use this while breastfeeding'],
    ['infant', 'is this cream safe for my baby'],
    ['medicine interaction', 'can I take this with my medication'],
    ['chronic condition', 'I am diabetic, will this suit me'],
    ['prescription', 'my dermatologist prescribed something already'],
    ['infection', 'the area looks infected and has pus'],
    ['diagnosis request', 'do I have a fungal infection'],
    ['dose change', 'should I stop taking my treatment'],
  ];

  for (const [name, message] of cases) {
    test(`fires for ${name}`, () => {
      assert.equal(urgencyOf(message), 'pharmacist_review', `expected pharmacist_review for: ${message}`);
    });
  }

  test('fires on Arabic input too', () => {
    const arabic = ['هل هذا آمن للحامل؟', 'هل يتعارض مع ادويتي؟', 'عندي سكري هل يناسبني'];
    for (const message of arabic) {
      assert.equal(urgencyOf(message), 'pharmacist_review', `expected pharmacist_review for: ${message}`);
    }
  });

  test('every pharmacist rule has at least one Arabic pattern', () => {
    for (const rule of PHARMACIST_RULES) {
      const hasArabic = rule.patterns.some((p) => /[؀-ۿ]/.test(p.source));
      assert.ok(hasArabic, `rule "${rule.id}" has no Arabic pattern`);
    }
  });
});

describe('trigger precedence and false positives', () => {
  test('an emergency outranks a pharmacist trigger in the same message', () => {
    const matches = detectTriggers('I am pregnant and I cannot breathe');
    assert.equal(highestUrgency(matches), 'emergency');
    assert.ok(matches.every((m) => m.urgency === 'emergency'), 'emergency should short-circuit');
  });

  test('ordinary shopping questions do not trigger anything', () => {
    const benign = [
      'do you have a moisturiser for dry skin',
      'what is the price of the CeraVe cleanser',
      'هل يوجد واقي شمس للبشرة الدهنية',
      'I want something gentle for my face',
      'which shampoo is best for frizz',
    ];
    for (const message of benign) {
      assert.equal(urgencyOf(message), null, `false positive on: ${message}`);
    }
  });
});

describe('sensitive data detection (§5.4)', () => {
  test('flags card numbers and passwords', () => {
    assert.ok(containsSensitiveData('my visa is 4111 1111 1111 1111'));
    assert.ok(containsSensitiveData('cvv: 123'));
    assert.ok(containsSensitiveData('my password is hunter2'));
    assert.ok(containsSensitiveData('civil id 290010112345'));
  });

  test('does not flag an ordinary order number', () => {
    assert.equal(containsSensitiveData('my order number is 10428'), false);
    assert.equal(containsSensitiveData('I ordered 3 items yesterday'), false);
  });
});

describe('pharmacist gate (§3.3 step 4)', () => {
  test('gates the whole vitamins category', () => {
    const result = evaluatePharmacistGate({ category: 'vitamins', text: 'A plain multivitamin.' });
    assert.ok(result.requiresPharmacistReview);
    assert.match(result.reasons.join(' '), /Vitamins/);
  });

  test('gates a face product that mentions pregnancy', () => {
    const result = evaluatePharmacistGate({
      category: 'face',
      text: 'Retinol serum. Not suitable during pregnancy.',
    });
    assert.ok(result.requiresPharmacistReview);
  });

  test('gates when the labeling model raises the flag itself', () => {
    const result = evaluatePharmacistGate({
      category: 'body',
      text: 'A body lotion.',
      modelFlaggedSensitive: true,
    });
    assert.ok(result.requiresPharmacistReview);
  });

  test('lets an ordinary cosmetic product through', () => {
    const result = evaluatePharmacistGate({
      category: 'face',
      text: 'Gentle foaming cleanser with glycerin for daily use.',
    });
    assert.equal(result.requiresPharmacistReview, false);
    assert.deepEqual(result.reasons, []);
  });
});
