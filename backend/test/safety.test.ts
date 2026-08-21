/**
 * Sensitive-data detection (spec §5.4) and the product-labeling pharmacist
 * gate (spec §3.3 step 4).
 *
 * The rule-based emergency/pharmacist-review escalation engine that used to
 * be tested here was removed by explicit store-owner decision, along with
 * the chat safety-trigger rules it was built on. Sensitive-data detection is
 * unrelated to that removal and still runs on every turn. The pharmacist
 * gate below is also unrelated — it is the AI-labeling pipeline's category
 * flag for vitamins/pregnancy-adjacent products, not a chat escalation.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { containsSensitiveData } from '../src/safety/engine.js';
import { evaluatePharmacistGate } from '../src/labeling/gate.js';

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
