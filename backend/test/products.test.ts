/**
 * WPML translation ingestion (name_ar/description_ar/short_description_ar):
 * a real translation must always win over nothing, but a sync that carries
 * no translation (untranslated product, or a plain non-WPML store) must
 * never blank out a value that's already there.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/db/index.js';
import { upsertWooFields, getProduct } from '../src/products/repository.js';
import { normalizeWooProduct } from '../src/products/normalize.js';

function baseFields(id: number) {
  return {
    product_id: id,
    sku: `SKU-${id}`,
    name: `Product ${id}`,
    permalink: null,
    image_url: null,
    short_description: null,
    description: null,
    categories: [],
    tags: [],
    brand: null,
    price: 10,
    regular_price: 10,
    sale_price: null,
    currency: 'KWD',
    size: null,
    stock_status: 'instock' as const,
    rating_average: null,
    rating_count: 0,
  };
}

describe('upsertWooFields: bilingual fields never regress on a translation-less sync', () => {
  test('a first insert with no translation leaves the bilingual fields null', () => {
    const conn = openMemoryDb();
    upsertWooFields(baseFields(1), conn);
    const product = getProduct(1, conn)!;
    assert.equal(product.name_ar, null);
    assert.equal(product.description_ar, null);
    assert.equal(product.short_description_ar, null);
  });

  test('a translation provided on sync is stored', () => {
    const conn = openMemoryDb();
    upsertWooFields(
      { ...baseFields(2), name_ar: 'اسم المنتج', description_ar: 'الوصف', short_description_ar: 'وصف قصير' },
      conn,
    );
    const product = getProduct(2, conn)!;
    assert.equal(product.name_ar, 'اسم المنتج');
    assert.equal(product.description_ar, 'الوصف');
    assert.equal(product.short_description_ar, 'وصف قصير');
  });

  test('a later sync with no translation does not erase a previously-synced one', () => {
    const conn = openMemoryDb();
    upsertWooFields({ ...baseFields(3), name_ar: 'اسم المنتج', description_ar: 'الوصف' }, conn);

    // Re-sync as if the product was re-saved (e.g. a price change) without
    // WPML's Arabic translation being resolved this time — must not wipe it.
    upsertWooFields(baseFields(3), conn);

    const product = getProduct(3, conn)!;
    assert.equal(product.name_ar, 'اسم المنتج', 'name_ar must survive a translation-less re-sync');
    assert.equal(product.description_ar, 'الوصف', 'description_ar must survive a translation-less re-sync');
  });

  test('a later sync WITH a translation overwrites the previous one (real translation always wins)', () => {
    const conn = openMemoryDb();
    upsertWooFields({ ...baseFields(4), name_ar: 'الاسم القديم' }, conn);
    upsertWooFields({ ...baseFields(4), name_ar: 'الاسم الجديد' }, conn);

    assert.equal(getProduct(4, conn)!.name_ar, 'الاسم الجديد');
  });

  test('every other WooCommerce-owned field still overwrites unconditionally', () => {
    const conn = openMemoryDb();
    upsertWooFields({ ...baseFields(5), price: 10 }, conn);
    upsertWooFields({ ...baseFields(5), price: 8 }, conn);

    assert.equal(getProduct(5, conn)!.price, 8, 'price is not subject to the bilingual-field COALESCE rule');
  });
});

describe('normalizeWooProduct: passes WPML fields through untouched by AI logic', () => {
  test('carries name_ar/description_ar/short_description_ar from the raw payload', () => {
    const normalized = normalizeWooProduct({
      id: 10,
      name: 'Vitamin C Serum',
      name_ar: 'سيروم فيتامين سي',
      description: '<p>Brightens skin.</p>',
      description_ar: '<p>يفتح لون البشرة.</p>',
      short_description: 'Brightening serum',
      short_description_ar: 'سيروم تفتيح',
    });

    assert.equal(normalized.name_ar, 'سيروم فيتامين سي');
    assert.equal(normalized.description_ar, 'يفتح لون البشرة.', 'HTML is stripped like the English description');
    assert.equal(normalized.short_description_ar, 'سيروم تفتيح');
  });

  test('a product with no WPML translation normalizes to null, not empty string', () => {
    const normalized = normalizeWooProduct({ id: 11, name: 'Plain Product' });
    assert.equal(normalized.name_ar, null);
    assert.equal(normalized.description_ar, null);
    assert.equal(normalized.short_description_ar, null);
  });
});
