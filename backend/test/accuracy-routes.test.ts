/**
 * The accuracy admin flow end to end, through Fastify's inject() and the real
 * signed-request guard, against a throwaway database:
 *
 *   WordPress pushes products (with ACF fields and category paths)
 *   → categories appear in the map → the admin maps them
 *   → a contested product type is confirmed → it becomes recommendable.
 *
 * No OpenAI call is made — labelling is simulated by writing the fields the
 * labeller would, so this stays offline.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDb = path.join(os.tmpdir(), `wwc-accuracy-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDb;
process.env.WP_SHARED_SECRET = 'test-secret-for-accuracy-routes';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-key-unused';

const { buildServer } = await import('../src/index.js');
const { sign } = await import('../src/security/hmac.js');
const { getProduct, updateWwcFields } = await import('../src/products/repository.js');
const { findProducts } = await import('../src/recommend/find.js');
const { allProducts } = await import('../src/products/repository.js');

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

function signedHeaders(body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    'content-type': 'application/json',
    'x-wellness-timestamp': ts,
    'x-wellness-signature': sign(body, ts, process.env.WP_SHARED_SECRET),
    'x-wellness-user': 'test-admin',
  };
}

async function adminPost(url: string, payload: unknown) {
  const body = JSON.stringify(payload);
  return app.inject({ method: 'POST', url, payload: body, headers: signedHeaders(body) });
}

async function adminGet(url: string) {
  return app.inject({ method: 'GET', url, headers: signedHeaders('') });
}

const HAIR = { id: 10, name: 'Hair Care', slug: 'hair-care', parent: 0, path: 'Hair Care' };
const SHAMPOO = { id: 11, name: 'Shampoo', slug: 'shampoo', parent: 10, path: 'Hair Care > Shampoo' };
const BRAND = { id: 20, name: 'Acme', slug: 'acme', parent: 0, path: 'Brands > Acme' };

describe('accuracy admin routes', () => {
  test('an unsigned request is refused', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/categories' });
    assert.equal(res.statusCode, 401);
  });

  test('a pushed product keeps its ACF fields, category ids and paths', async () => {
    const res = await adminPost('/api/admin/catalogue/import', {
      products: [
        {
          id: 501,
          name: 'Hydra Moisture Shampoo 250ml',
          description: '<p>A gentle shampoo for <b>dry</b> scalps.</p>',
          categories: [HAIR, SHAMPOO, BRAND],
          tags: [{ id: 1, name: 'dry hair', slug: 'dry-hair' }],
          ingredients: '<p>Aqua, Glycerin, Panthenol</p>',
          how_to_use: 'Massage into wet hair, rinse.',
          how_to_use_ar: '',
        },
        {
          id: 502,
          name: 'Rosemary Shampoo Bar',
          categories: [HAIR],
        },
      ],
    });
    assert.equal(res.statusCode, 200, res.body);

    const p = getProduct(501)!;
    assert.equal(p.full_ingredients, 'Aqua, Glycerin, Panthenol');
    assert.equal(p.how_to_use_source.en, 'Massage into wet hair, rinse.');
    assert.equal(p.how_to_use_source.ar, null);
    assert.deepEqual(p.woo_category_ids, [10, 11, 20]);
    assert.deepEqual(p.category_paths, ['Hair Care', 'Hair Care > Shampoo', 'Brands > Acme']);
  });

  test('a payload without the ACF keys leaves stored values alone', async () => {
    await adminPost('/api/admin/catalogue/import', {
      products: [{ id: 501, name: 'Hydra Moisture Shampoo 250ml', categories: [HAIR, SHAMPOO, BRAND] }],
    });
    const p = getProduct(501)!;
    assert.equal(p.full_ingredients, 'Aqua, Glycerin, Panthenol', 'an older plugin build must not wipe ingredients');
  });

  test('categories appear in the map with product counts', async () => {
    const res = await adminGet('/api/admin/categories');
    assert.equal(res.statusCode, 200, res.body);
    const cats = res.json().categories as { woo_category_id: number; path: string; product_count: number; confirmed: boolean }[];
    const shampoo = cats.find((c) => c.woo_category_id === 11)!;
    assert.equal(shampoo.path, 'Hair Care > Shampoo');
    assert.equal(shampoo.product_count, 1);
    assert.equal(cats.find((c) => c.woo_category_id === 10)!.product_count, 2);
    assert.equal(shampoo.confirmed, false);
  });

  test('saving a mapping confirms it and rejects unknown shelves', async () => {
    const res = await adminPost('/api/admin/categories', {
      mappings: [
        { woo_category_id: 10, shelf: 'hair' },
        { woo_category_id: 11, shelf: 'hair', fixed_product_type: 'shampoo' },
        { woo_category_id: 20, shelf: 'none' },
        { woo_category_id: 99, shelf: 'kitchen' },
      ],
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().saved, 3);
    const shampoo = (res.json().categories as { woo_category_id: number; confirmed: boolean; effective_product_type: string }[]).find(
      (c) => c.woo_category_id === 11,
    )!;
    assert.equal(shampoo.confirmed, true);
    assert.equal(shampoo.effective_product_type, 'shampoo');
  });

  test('a contested product is listed, held back, then released when the admin confirms its type', async () => {
    // What the labeller would write for 502 if the model called it a hair oil.
    for (const id of [501, 502]) {
      updateWwcFields(id, {
        verification_status: 'verified',
        ai_generated: true,
        ai_confidence: 0.9,
        concern_primary: { en: ['dryness'], ar: [] },
        product_type: id === 501 ? 'shampoo' : 'hair_oil',
        application: 'hair_scalp',
        product_type_source: 'ai',
        label_issues: id === 501 ? [] : ['The name mentions "shampoo" but the product type is "hair_oil".'],
      });
    }

    const listed = await adminGet('/api/admin/products?issues=1');
    assert.deepEqual(
      (listed.json().rows as { product_id: number }[]).map((r) => r.product_id),
      [502],
    );

    // Excluding 501 leaves only the contested product — which must not show.
    const request = { product_types: ['shampoo'], concerns: ['dryness'], exclude_ids: [501] };
    const before = findProducts(request, { catalogue: allProducts() });
    assert.equal(before.status, 'none_of_type', 'the contested product is not shown');

    const set = await adminPost('/api/admin/products/502/type', { product_type: 'shampoo' });
    assert.equal(set.statusCode, 200, set.body);
    const p = getProduct(502)!;
    assert.equal(p.product_type, 'shampoo');
    assert.equal(p.product_type_source, 'admin');
    assert.deepEqual(p.label_issues, []);

    const after = findProducts(request, { catalogue: allProducts() });
    assert.equal(after.status, 'matched');
    assert.deepEqual(
      after.selection!.picks.map((x) => x.scored.product.product_id),
      [502],
      'confirmed product is recommendable',
    );
  });

  test('an unknown product type is refused', async () => {
    const res = await adminPost('/api/admin/products/501/type', { product_type: 'magic_potion' });
    assert.equal(res.statusCode, 400);
  });

  test('the summary counts types and issues', async () => {
    const res = await adminGet('/api/admin/accuracy/summary');
    const s = res.json();
    assert.equal(s.by_type.shampoo, 2);
    assert.equal(s.with_issues, 0);
    assert.equal(s.categories_confirmed, 3);
  });
});
