/**
 * Category resolution and the medicine classifier.
 *
 * Context: a real pharmacy catalogue is ~48 WooCommerce categories wide, but
 * only four of them are consultative shelves. Everything else used to resolve
 * to null, which stranded those products permanently in the review queue.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveProductCategory,
  matchedSpecificShelf,
  isLikelyMedicine,
} from '../src/products/category.js';

describe('resolveProductCategory', () => {
  test('still resolves the four consultative shelves from taxonomy', () => {
    assert.equal(resolveProductCategory({ categories: ['Face Care'] }), 'face');
    assert.equal(resolveProductCategory({ categories: ['Body Care'] }), 'body');
    assert.equal(resolveProductCategory({ categories: ['Hair & Scalp'] }), 'hair');
    assert.equal(resolveProductCategory({ categories: ['Vitamins'] }), 'vitamins');
  });

  test('falls back to general instead of null for anything else', () => {
    assert.equal(
      resolveProductCategory({ categories: ['Makeup'], name: 'KORFF Cure Make Up Lip Pencil 1.08g' }),
      'general',
    );
    assert.equal(
      resolveProductCategory({ categories: ['Antibiotics'], name: 'AUGMENTIN 1G 14 TAB' }),
      'general',
    );
    assert.equal(resolveProductCategory({}), 'general', 'no taxonomy at all is still not a dead end');
  });

  test('matchedSpecificShelf distinguishes a real match from the fallback', () => {
    assert.equal(matchedSpecificShelf({ categories: ['Face Care'] }), true);
    assert.equal(matchedSpecificShelf({ categories: ['Makeup'] }), false);
  });
});

describe('isLikelyMedicine', () => {
  test('detects a medicine from a strength plus dosage form in the name', () => {
    assert.equal(isLikelyMedicine({ name: 'AUGMENTIN 1G 14 TAB' }), true);
    assert.equal(isLikelyMedicine({ name: 'Amoxicillin 500mg Capsules' }), true);
  });

  test('detects a medicine from the WooCommerce category name', () => {
    assert.equal(isLikelyMedicine({ categories: ['Prescription Medicines'] }), true);
    assert.equal(isLikelyMedicine({ categories: ['Antibiotics'] }), true);
    assert.equal(isLikelyMedicine({ tags: ['أدوية'] }), true);
  });

  test('does not flag ordinary merchandise', () => {
    assert.equal(isLikelyMedicine({ categories: ['Makeup'], name: 'KORFF Lip Pencil 1.08g' }), false);
    assert.equal(isLikelyMedicine({ categories: ['Face Care'], name: 'Vitamin C Serum 30ml' }), false);
    assert.equal(isLikelyMedicine({ name: 'Baby Shampoo 200ml' }), false);
  });

  test('a strength alone, with no dosage form, is not enough', () => {
    // "30ml" on a serum must not read as a medicine.
    assert.equal(isLikelyMedicine({ name: 'Niacinamide 10% Serum 30ml' }), false);
  });
});
