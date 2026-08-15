/**
 * Label-skip eligibility and the unreviewed-drafts reset (added after a
 * production incident: an unbounded labeling run left hundreds of pending
 * drafts, and a re-run needed to guarantee it would never re-spend on
 * anything already touched).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, toJson } from '../src/db/index.js';
import {
  isEligibleForLabeling,
  resetUnreviewedLabels,
  applyReview,
  type ReviewDecision,
} from '../src/labeling/pipeline.js';
import { upsertWooFields, updateWwcFields, getProduct } from '../src/products/repository.js';

describe('isEligibleForLabeling (pure)', () => {
  test('a never-touched product is eligible', () => {
    assert.equal(
      isEligibleForLabeling({ ai_generated: false, verification_status: 'unverified' }),
      true,
    );
  });

  test('a product that already has an AI draft is not eligible, regardless of the draft\'s own status', () => {
    // ai_generated stays true whether the draft is pending, rejected, or
    // superseded — only a human review changes it back to false.
    assert.equal(
      isEligibleForLabeling({ ai_generated: true, verification_status: 'unverified' }),
      false,
    );
  });

  test('a verified product is never eligible', () => {
    assert.equal(
      isEligibleForLabeling({ ai_generated: false, verification_status: 'verified' }),
      false,
    );
  });

  test('a partial product is never eligible', () => {
    assert.equal(
      isEligibleForLabeling({ ai_generated: false, verification_status: 'partial' }),
      false,
    );
  });
});

function seedProduct(
  conn: ReturnType<typeof openMemoryDb>,
  id: number,
  overrides: Record<string, unknown> = {},
) {
  upsertWooFields(
    {
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
      stock_status: 'instock',
      rating_average: null,
      rating_count: 0,
    },
    conn,
  );
  if (Object.keys(overrides).length) updateWwcFields(id, overrides, conn);
}

function insertDraft(conn: ReturnType<typeof openMemoryDb>, productId: number, status: string) {
  conn
    .prepare(
      `INSERT INTO label_drafts (product_id, category, draft_json, confidence, model, status, created_at)
       VALUES (?, 'face', ?, 0.5, 'test-model', ?, datetime('now'))`,
    )
    .run(productId, toJson({ confidence: 0.5 }), status);
}

describe('resetUnreviewedLabels', () => {
  test('resets an AI-labeled, unverified product back to a clean state', () => {
    const conn = openMemoryDb();
    seedProduct(conn, 1, {
      ai_generated: true,
      ai_confidence: 0.42,
      concern_primary: { en: ['acne'], ar: [] },
      fragrance: 'yes',
      verification_status: 'unverified',
    });
    insertDraft(conn, 1, 'pending');

    const result = resetUnreviewedLabels('tester', conn);

    assert.equal(result.products_reset, 1);
    assert.equal(result.drafts_removed, 1);

    const product = getProduct(1, conn)!;
    assert.equal(product.ai_generated, false);
    assert.equal(product.ai_confidence, null);
    assert.deepEqual(product.concern_primary, { en: [], ar: [] });
    assert.equal(product.fragrance, 'unspecified');
    assert.equal(product.verification_status, 'unverified');

    const remainingDrafts = conn
      .prepare('SELECT COUNT(*) AS c FROM label_drafts WHERE product_id = 1')
      .get() as { c: number };
    assert.equal(remainingDrafts.c, 0);
  });

  test('never touches a verified product, even if it still says ai_generated', () => {
    const conn = openMemoryDb();
    // A pharmacist-verified product always has ai_generated=false in practice
    // (applyReview sets it), but the reset guards on verification_status too,
    // defense in depth against that invariant ever slipping.
    seedProduct(conn, 2, {
      ai_generated: true,
      verification_status: 'verified',
      concern_primary: { en: ['dryness'], ar: [] },
    });
    insertDraft(conn, 2, 'approved');

    const result = resetUnreviewedLabels('tester', conn);

    assert.equal(result.products_reset, 0);
    assert.equal(result.drafts_removed, 0);

    const product = getProduct(2, conn)!;
    assert.equal(product.verification_status, 'verified');
    assert.deepEqual(product.concern_primary, { en: ['dryness'], ar: [] });

    const remainingDrafts = conn
      .prepare('SELECT COUNT(*) AS c FROM label_drafts WHERE product_id = 2')
      .get() as { c: number };
    assert.equal(remainingDrafts.c, 1, 'the approved draft must survive as an audit record');
  });

  test('never touches a partial product', () => {
    const conn = openMemoryDb();
    seedProduct(conn, 3, { ai_generated: false, verification_status: 'partial' });

    const result = resetUnreviewedLabels('tester', conn);
    assert.equal(result.products_reset, 0);
    assert.equal(getProduct(3, conn)!.verification_status, 'partial');
  });

  test('a never-labeled product is left alone (nothing to reset)', () => {
    const conn = openMemoryDb();
    seedProduct(conn, 4); // fresh import, ai_generated=false, unverified

    const result = resetUnreviewedLabels('tester', conn);
    assert.equal(result.products_reset, 0);
    assert.equal(result.drafts_removed, 0);
  });

  test('resets many products in one call and leaves verified ones interspersed untouched', () => {
    const conn = openMemoryDb();
    seedProduct(conn, 10, { ai_generated: true, verification_status: 'unverified' });
    insertDraft(conn, 10, 'pending');
    seedProduct(conn, 11, { ai_generated: false, verification_status: 'verified' });
    seedProduct(conn, 12, { ai_generated: true, verification_status: 'unverified' });
    insertDraft(conn, 12, 'rejected');
    seedProduct(conn, 13, { ai_generated: false, verification_status: 'unverified' }); // never labeled

    const result = resetUnreviewedLabels('tester', conn);

    assert.equal(result.products_reset, 2, 'only 10 and 12 qualify');
    assert.equal(getProduct(10, conn)!.ai_generated, false);
    assert.equal(getProduct(12, conn)!.ai_generated, false);
    assert.equal(getProduct(11, conn)!.verification_status, 'verified', 'untouched');
    assert.equal(getProduct(13, conn)!.ai_generated, false, 'was already false, stays false');
  });
});

function insertPendingDraft(conn: ReturnType<typeof openMemoryDb>, productId: number): number {
  const result = conn
    .prepare(
      `INSERT INTO label_drafts (product_id, category, draft_json, confidence, model, status, created_at)
       VALUES (?, 'vitamins', ?, 0.5, 'test-model', 'pending', datetime('now'))`,
    )
    .run(productId, toJson({ confidence: 0.5 }));
  return Number(result.lastInsertRowid);
}

function baseDecision(draftId: number, overrides: Partial<ReviewDecision> = {}): ReviewDecision {
  return {
    draftId,
    action: 'approve',
    status: 'verified',
    reviewer: 'admin1',
    reviewerIsPharmacist: false,
    ...overrides,
  };
}

// Pharmacist review is informational, not mandatory: any admin may approve
// any product, gated or not. `verified_by_pharmacist` must still only ever
// record whether an actual pharmacist reviewer did it.
describe('applyReview: pharmacist review is never mandatory', () => {
  test('gated product + non-pharmacist reviewer: approval succeeds, verified_by_pharmacist stays false', () => {
    const conn = openMemoryDb();
    seedProduct(conn, 100, { requires_pharmacist_review: true, verification_status: 'unverified' });
    const draftId = insertPendingDraft(conn, 100);

    const result = applyReview(baseDecision(draftId), conn);

    assert.equal(result.status, 'verified');
    const product = getProduct(100, conn)!;
    assert.equal(product.verification_status, 'verified');
    assert.equal(
      product.verified_by_pharmacist,
      false,
      'audit trail must stay honest — this was not actually a pharmacist',
    );
  });

  test('gated product + pharmacist reviewer: verified_by_pharmacist set true', () => {
    const conn = openMemoryDb();
    seedProduct(conn, 101, { requires_pharmacist_review: true, verification_status: 'unverified' });
    const draftId = insertPendingDraft(conn, 101);

    const result = applyReview(baseDecision(draftId, { reviewerIsPharmacist: true }), conn);

    assert.equal(result.status, 'verified');
    const product = getProduct(101, conn)!;
    assert.equal(product.verification_status, 'verified');
    assert.equal(product.verified_by_pharmacist, true);
  });

  test('non-gated product + non-pharmacist reviewer: unaffected, as before', () => {
    const conn = openMemoryDb();
    seedProduct(conn, 102, { requires_pharmacist_review: false, verification_status: 'unverified' });
    const draftId = insertPendingDraft(conn, 102);

    const result = applyReview(baseDecision(draftId), conn);

    assert.equal(result.status, 'verified');
    assert.equal(getProduct(102, conn)!.verification_status, 'verified');
  });
});
