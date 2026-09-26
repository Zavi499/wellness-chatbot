/**
 * Skin/hair analyzer: photo validation, pre-fill safety, and the fact that
 * the analyzer feeds the same recommendation engine as the chat.
 *
 * No network and no API key — the vision call itself is the only part that
 * talks to OpenAI, and everything around it is pure.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDataUrl,
  sanitizeSuggestions,
  emptyReading,
  MAX_IMAGE_BYTES,
} from '../src/analyzer/vision.js';
import { ANALYZERS, isAnalyzerKind } from '../src/analyzer/config.js';
import { nextQuestion } from '../src/questionnaire/engine.js';
import { buildProfile } from '../src/recommend/profile.js';

/** A valid tiny data URL, padded to a requested decoded size. */
function dataUrl(bytes: number, mime = 'image/jpeg'): string {
  const chars = Math.ceil(bytes / 3) * 4;
  return `data:${mime};base64,${'A'.repeat(chars)}`;
}

describe('validateDataUrl', () => {
  test('accepts the image types a browser canvas actually produces', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
      assert.equal(validateDataUrl(dataUrl(1000, mime)), null, mime);
    }
  });

  test('rejects anything that is not an image data URL', () => {
    assert.equal(validateDataUrl(''), 'not_an_image');
    assert.equal(validateDataUrl('https://example.com/cat.jpg'), 'not_an_image');
    assert.equal(validateDataUrl('data:text/html;base64,PHNjcmlwdD4='), 'not_an_image');
    assert.equal(validateDataUrl('data:application/pdf;base64,AAAA'), 'not_an_image');
  });

  test('rejects a payload past the size ceiling before any token is spent', () => {
    assert.equal(validateDataUrl(dataUrl(MAX_IMAGE_BYTES + 50_000)), 'too_large');
  });

  test('accepts one just under the ceiling', () => {
    assert.equal(validateDataUrl(dataUrl(MAX_IMAGE_BYTES - 50_000)), null);
  });
});

describe('sanitizeSuggestions', () => {
  const skin = ANALYZERS.skin;

  test('keeps values the questionnaire actually offers', () => {
    const out = sanitizeSuggestions(skin, { skin_type: 'oily', concern_primary: 'acne' });
    assert.deepEqual(out, { skin_type: 'oily', concern_primary: 'acne' });
  });

  test('drops a value the questionnaire does not offer', () => {
    // The model inventing its own vocabulary must not reach scoring.
    const out = sanitizeSuggestions(skin, { skin_type: 'dehydrated-ish' });
    assert.deepEqual(out, {});
  });

  test('drops keys outside the allow-list, however plausible', () => {
    // A photo may say what skin looks like. It may not decide a budget.
    const out = sanitizeSuggestions(skin, { budget: 'high', product_type: 'serum' });
    assert.deepEqual(out, {});
  });

  test('does not pre-fill "not_sure" — it costs a tap and says nothing', () => {
    assert.deepEqual(sanitizeSuggestions(skin, { skin_type: 'not_sure' }), {});
  });

  test('a hair photo can only pre-fill hair keys', () => {
    const out = sanitizeSuggestions(ANALYZERS.hair, {
      hair_pattern: 'curly',
      skin_type: 'oily',
    });
    assert.deepEqual(out, { hair_pattern: 'curly' });
  });

  test('missing or empty input is simply no pre-fill', () => {
    assert.deepEqual(sanitizeSuggestions(skin, undefined), {});
    assert.deepEqual(sanitizeSuggestions(skin, { skin_type: '' }), {});
  });
});

describe('emptyReading', () => {
  test('an unusable photo carries a reason and no pre-fill', () => {
    const r = emptyReading({ unusable_reason: 'too dark' });
    assert.equal(r.usable, false);
    assert.equal(r.unusable_reason, 'too dark');
    assert.deepEqual(r.suggested_answers, {});
  });
});

describe('analyzer wiring', () => {
  test('each kind points at the shelf and questionnaire it should', () => {
    assert.equal(ANALYZERS.skin.category, 'face');
    assert.equal(ANALYZERS.skin.questionnaire, 'face');
    assert.equal(ANALYZERS.hair.category, 'hair');
    assert.equal(ANALYZERS.hair.questionnaire, 'hair');
  });

  test('isAnalyzerKind rejects anything else', () => {
    assert.equal(isAnalyzerKind('skin'), true);
    assert.equal(isAnalyzerKind('hair'), true);
    assert.equal(isAnalyzerKind('face'), false);
    assert.equal(isAnalyzerKind(undefined), false);
  });

  test('the analyzer asks more questions than the chat, including the optional ones', () => {
    const chat = nextQuestion('face', {});
    const analyzer = nextQuestion('face', {}, { includeOptional: true });
    assert.ok(
      analyzer.total > chat.total,
      'the analyzer must reach "what are you currently using", which is optional',
    );
  });

  test('a pre-filled answer removes that question from the remaining steps', () => {
    const before = nextQuestion('face', { help_topic: 'face' }, { includeOptional: true });
    const after = nextQuestion(
      'face',
      { help_topic: 'face', [before.question!.key]: before.question!.options[0]!.value },
      { includeOptional: true },
    );
    assert.notEqual(after.question?.key, before.question?.key);
  });

  test('analyzer answers build the same profile shape the chat produces', () => {
    const profile = buildProfile(ANALYZERS.skin.category, {
      help_topic: 'face',
      skin_type: 'oily',
      concern_primary: 'acne',
      sensitivity_level: 'somewhat',
      budget: 'mid',
    });
    assert.equal(profile.category, 'face');
    assert.equal(profile.concern_primary, 'acne');
    assert.ok(profile.types.includes('oily'));
  });
});
