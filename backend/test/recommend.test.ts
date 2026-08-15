/**
 * Eligibility, scoring and top-three selection (spec §3.4, §4.5, §4.6).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkEligibility, filterEligible } from '../src/recommend/eligibility.js';
import { scoreProduct, WEIGHTS } from '../src/recommend/scoring.js';
import { selectTopThree, toRecommendationSet } from '../src/recommend/select.js';
import { buildProfile } from '../src/recommend/profile.js';
import type { Product } from '../src/types.js';

let nextId = 1;

function product(overrides: Partial<Product> = {}): Product {
  const id = nextId++;
  return {
    product_id: id,
    sku: `SKU-${id}`,
    name: `Test product ${id}`,
    name_ar: null,
    permalink: `https://example.com/p/${id}`,
    image_url: null,
    short_description: null,
    description: null,
    categories: ['Face Care'],
    tags: [],
    brand: `Brand ${id}`,
    price: 10,
    regular_price: 10,
    sale_price: null,
    currency: 'KWD',
    size: '100 ml',
    stock_status: 'instock',
    rating_average: null,
    rating_count: 0,
    verification_status: 'verified',
    ai_generated: false,
    ai_confidence: null,
    requires_pharmacist_review: false,
    verified_by_pharmacist: false,
    concern_primary: { en: ['acne'], ar: [] },
    concern_secondary: { en: [], ar: [] },
    suitable_types: { en: ['oily'], ar: [] },
    not_ideal_for: { en: null, ar: null },
    key_ingredients: ['niacinamide'],
    full_ingredients: null,
    texture_finish: { en: 'light gel', ar: null },
    fragrance: 'no',
    fragrance_type: null,
    alcohol: 'no',
    alcohol_type: null,
    how_to_use: { en: 'Apply daily.', ar: null },
    routine_step: 'treat',
    routine_time: 'both',
    age_suitability: 'all',
    age_min: null,
    age_max: null,
    pregnancy_guidance: null,
    warnings: { en: null, ar: null },
    complementary_products: [],
    alternative_products: [],
    source_verification_date: null,
    source_verification_note: null,
    synonyms_en: [],
    synonyms_ar: [],
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const profile = buildProfile('face', {
  skin_type: 'oily',
  concern_primary: 'acne',
  sensitivity_level: 'somewhat',
  budget: 'mid',
});

describe('eligibility (§3.4)', () => {
  test('accepts a verified, in-stock, matching product', () => {
    assert.equal(checkEligibility(product(), profile).eligible, true);
  });

  test('rejects an unverified product', () => {
    const result = checkEligibility(product({ verification_status: 'unverified' }), profile);
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.includes('not_verified'));
  });

  test('rejects an out-of-stock product', () => {
    const result = checkEligibility(product({ stock_status: 'outofstock' }), profile);
    assert.ok(result.reasons.includes('out_of_stock'));
  });

  test('a pharmacist-flagged product needs pharmacist verification, not just verified', () => {
    const merelyVerified = product({ requires_pharmacist_review: true, verified_by_pharmacist: false });
    assert.ok(
      checkEligibility(merelyVerified, profile).reasons.includes('needs_pharmacist_verification'),
      'admin-only verification must not be enough',
    );

    const properlyVerified = product({ requires_pharmacist_review: true, verified_by_pharmacist: true });
    assert.equal(checkEligibility(properlyVerified, profile).eligible, true);
  });

  test('ALLOW_NON_PHARMACIST_APPROVAL: an admin-only verified, gated product becomes eligible when the flag is on', () => {
    const adminVerified = product({ requires_pharmacist_review: true, verified_by_pharmacist: false });

    assert.ok(
      checkEligibility(adminVerified, profile, { allowNonPharmacistApproval: false }).reasons.includes(
        'needs_pharmacist_verification',
      ),
      'off by default — same behaviour as no option passed at all',
    );
    assert.equal(
      checkEligibility(adminVerified, profile, { allowNonPharmacistApproval: true }).eligible,
      true,
      'store explicitly opted in — any admin approval now counts',
    );
  });

  test('ALLOW_NON_PHARMACIST_APPROVAL never rescues a merely `partial` gated product', () => {
    const partialGated = product({
      verification_status: 'partial',
      requires_pharmacist_review: true,
      verified_by_pharmacist: false,
    });
    const result = checkEligibility(partialGated, profile, { allowNonPharmacistApproval: true });
    assert.ok(
      result.reasons.includes('needs_pharmacist_verification'),
      'only `verified` qualifies a gated product, even with the flag on — partial (e.g. bulk-approve) must stay inert here',
    );
  });

  test('rejects a product whose not_ideal_for conflicts with the customer', () => {
    const sensitiveProfile = buildProfile('face', {
      skin_type: 'sensitive',
      concern_primary: 'acne',
      sensitivity_level: 'very',
    });
    const result = checkEligibility(
      product({ not_ideal_for: { en: 'Not ideal for sensitive skin', ar: null } }),
      sensitiveProfile,
    );
    assert.ok(result.reasons.includes('not_ideal_for_conflict'));
  });

  test('respects an ingredient the customer asked to avoid', () => {
    const avoidRetinol = buildProfile('face', {
      concern_primary: 'ageing',
      avoid_ingredients: ['retinol'],
    });
    const result = checkEligibility(product({ key_ingredients: ['Retinol'] }), avoidRetinol);
    assert.ok(result.reasons.includes('avoided_ingredient'));
  });

  test('never shows an adult-only product for a child', () => {
    const forChild = buildProfile('face', { who_for: 'child', concern_primary: 'dryness' });
    const result = checkEligibility(product({ age_suitability: 'adult' }), forChild);
    assert.ok(result.reasons.includes('age_conflict'));
  });

  test('rejects a product from another category', () => {
    const result = checkEligibility(product({ categories: ['Hair & Scalp'], tags: [] }), profile);
    assert.ok(result.reasons.includes('category_mismatch'));
  });
});

describe('scoring (§4.6)', () => {
  test('weights total 100', () => {
    const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    assert.equal(total, 100);
  });

  test('a matching concern scores higher than a mismatched one', () => {
    const match = scoreProduct(product(), profile, []);
    const miss = scoreProduct(product({ concern_primary: { en: ['dandruff'], ar: [] } }), profile, []);
    assert.ok(match.score > miss.score, `${match.score} should beat ${miss.score}`);
  });

  test('fragrance-free scores better for very sensitive skin', () => {
    const sensitive = buildProfile('face', {
      skin_type: 'sensitive',
      concern_primary: 'acne',
      sensitivity_level: 'very',
    });
    const gentle = scoreProduct(product({ fragrance: 'no' }), sensitive, []);
    const fragranced = scoreProduct(product({ fragrance: 'yes' }), sensitive, []);
    assert.ok(gentle.breakdown.sensitivity_safety > fragranced.breakdown.sensitivity_safety);
  });

  test('an out-of-stock product loses the availability points', () => {
    const inStock = scoreProduct(product(), profile, []);
    const outOfStock = scoreProduct(product({ stock_status: 'outofstock' }), profile, []);
    assert.equal(inStock.breakdown.availability, WEIGHTS.availability);
    assert.equal(outOfStock.breakdown.availability, 0);
  });

  test('a near-duplicate of an already-chosen product is penalised', () => {
    const chosen = product({ brand: 'Same', routine_step: 'treat', key_ingredients: ['niacinamide'] });
    const duplicate = product({ brand: 'Same', routine_step: 'treat', key_ingredients: ['niacinamide'] });
    const distinct = product({ brand: 'Other', routine_step: 'cleanse', key_ingredients: ['glycerin'] });

    const dupScore = scoreProduct(duplicate, profile, [], [chosen]).breakdown.diversity;
    const distinctScore = scoreProduct(distinct, profile, [], [chosen]).breakdown.diversity;
    assert.ok(distinctScore > dupScore);
  });

  test('reviews only count once there are enough of them', () => {
    const fewReviews = scoreProduct(product({ rating_average: 5, rating_count: 2 }), profile, []);
    const manyReviews = scoreProduct(product({ rating_average: 5, rating_count: 50 }), profile, []);
    assert.ok(manyReviews.breakdown.customer_rating > fewReviews.breakdown.customer_rating);
  });
});

describe('top-three selection (§4.6)', () => {
  test('picks three meaningfully different products', () => {
    const catalogue = [
      product({ name: 'Premium gel', price: 24, brand: 'Alpha', texture_finish: { en: 'gel', ar: null } }),
      product({ name: 'Value cream', price: 6, brand: 'Beta', texture_finish: { en: 'cream', ar: null } }),
      product({ name: 'Middle oil', price: 12, brand: 'Gamma', texture_finish: { en: 'oil', ar: null } }),
    ];

    const result = selectTopThree(profile, { catalogue });
    assert.equal(result.picks.length, 3);
    assert.deepEqual(
      result.picks.map((p) => p.slot),
      ['best_overall', 'best_value', 'alternative'],
    );

    const ids = result.picks.map((p) => p.scored.product.product_id);
    assert.equal(new Set(ids).size, 3, 'the three picks must be distinct products');
  });

  test('Best Value is materially cheaper than Best Overall', () => {
    const catalogue = [
      product({ price: 30, brand: 'Alpha' }),
      product({ price: 8, brand: 'Beta' }),
      product({ price: 29, brand: 'Gamma' }),
    ];
    const result = selectTopThree(profile, { catalogue });
    const overall = result.picks.find((p) => p.slot === 'best_overall')!;
    const value = result.picks.find((p) => p.slot === 'best_value');

    if (value) {
      assert.ok(
        (value.scored.product.price ?? 0) <= (overall.scored.product.price ?? 0) * 0.85,
        'Best Value must be at least 15% cheaper',
      );
    }
  });

  test('returns fewer than three rather than padding with a poor match', () => {
    const catalogue = [product({ price: 10 })];
    const result = selectTopThree(profile, { catalogue });
    assert.equal(result.picks.length, 1);
    assert.equal(result.shortfall, true);

    const set = toRecommendationSet(result, 'en');
    assert.ok(set.shortfall_note, 'the customer must be told the list is short');
  });

  test('returns nothing when the catalogue has no eligible product', () => {
    const catalogue = [product({ verification_status: 'unverified' }), product({ stock_status: 'outofstock' })];
    const result = selectTopThree(profile, { catalogue });
    assert.equal(result.picks.length, 0);
    assert.equal(toRecommendationSet(result, 'en').items.length, 0);
  });

  test('honours must-exclude ids so "replace this option" works', () => {
    const keep = product({ price: 10, brand: 'Alpha' });
    const drop = product({ price: 9, brand: 'Beta' });
    const result = selectTopThree(profile, {
      catalogue: [keep, drop],
      excludeIds: [drop.product_id],
    });
    assert.ok(result.picks.every((p) => p.scored.product.product_id !== drop.product_id));
  });

  test('the Arabic card set uses Arabic labels', () => {
    const result = selectTopThree(profile, { catalogue: [product()] });
    const set = toRecommendationSet(result, 'ar');
    assert.equal(set.items[0]?.label, 'الأنسب لك');
    assert.match(set.disclaimer, /[؀-ۿ]/);
  });
});
