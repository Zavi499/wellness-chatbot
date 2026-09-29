/**
 * AI auto-labeling pipeline (spec §3.3).
 *
 * Flow: fetch product → structured-output call → write straight to `verified`.
 * By explicit store-owner decision, labeling is direct — no human review step,
 * for any category, including vitamins/supplements and anything mentioning
 * pregnancy, children, or medicines. The one exception is a product whose
 * category cannot be resolved at all (see `labelProduct()` below): there is no
 * generated content to make recommendable, so that case still lands in the
 * queue as `unverified` — not a review gate, just nothing to show yet.
 */
import type { DatabaseSync } from 'node:sqlite';
import { db, nowIso, toJson } from '../db/index.js';
import { openai, models } from '../openai/client.js';
import { config } from '../config.js';
import { getProduct, updateWwcFields, allProducts } from '../products/repository.js';
import type { ProductCategory } from '../products/category.js';
import { productShelf, resolveFromCategories } from '../products/category-map.js';
import {
  isApplication,
  isProductType,
  typeApplication,
  type ProductApplication,
  type ProductType,
} from '../products/types.js';
import { labelingSystemPrompt, labelingUserPrompt } from './prompts.js';
import { LABEL_SCHEMAS, type LabelDraft } from './schemas.js';
import { evaluatePharmacistGate } from './gate.js';
import { productTypeIssues } from './sanity.js';
import { reindexProduct } from '../search/embeddings.js';
import { logAudit } from '../analytics/audit.js';
import type { Bilingual, Product } from '../types.js';

export interface LabelRunResult {
  product_id: number;
  draft_id: number;
  category: ProductCategory;
  confidence: number;
  product_type: ProductType | null;
  label_issues: string[];
  requires_pharmacist_review: boolean;
  gate_reasons: string[];
}

function clampConfidence(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Everything the gate should scan: source text plus the model's own output. */
function gateText(product: Product, draft: LabelDraft): string {
  return [
    product.name,
    product.short_description,
    product.description,
    product.full_ingredients,
    JSON.stringify(draft),
  ]
    .filter(Boolean)
    .join('\n');
}

async function callLabelingModel(
  product: Product,
  category: ProductCategory,
  fixedType: ProductType | null,
): Promise<{ draft: LabelDraft; model: string }> {
  const model = models.label();
  const response = await openai().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: labelingSystemPrompt(category) },
      {
        role: 'user',
        content: labelingUserPrompt({
          name: product.name,
          category,
          categoryPaths: product.category_paths.length ? product.category_paths : product.categories,
          tags: product.tags,
          description: product.description,
          shortDescription: product.short_description,
          ingredientsRaw: product.full_ingredients,
          howToUse: product.how_to_use_source.en,
          brand: product.brand,
          fixedType,
          existingNameAr: product.name_ar,
          existingDescriptionAr: product.description_ar,
        }),
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'wwc_product_labels',
        strict: true,
        schema: LABEL_SCHEMAS[category],
      },
    },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error(`Labeling model returned no content for product ${product.product_id}`);

  let draft: LabelDraft;
  try {
    draft = JSON.parse(content) as LabelDraft;
  } catch (err) {
    throw new Error(`Labeling model returned invalid JSON for product ${product.product_id}: ${String(err)}`);
  }
  return { draft, model };
}

export interface TypeDecision {
  product_type: ProductType | null;
  application: ProductApplication | null;
  source: 'ai' | 'category' | 'admin';
  issues: string[];
}

/**
 * Settles a product's type, most authoritative source first: an admin's own
 * correction is never overwritten by a relabel; a category the admin mapped
 * to a fixed type ("Shampoos" → shampoo) beats the model; the model decides
 * everything else. The result is then checked against the product's name —
 * see `sanity.ts` — except when an admin set it, since that IS the check.
 */
export function decideType(
  product: Pick<Product, 'name' | 'product_type' | 'product_type_source'>,
  draft: Pick<LabelDraft, 'product_type' | 'application'>,
  fixedType: ProductType | null,
): TypeDecision {
  if (product.product_type_source === 'admin' && product.product_type) {
    return {
      product_type: product.product_type,
      application: typeApplication(product.product_type) ?? (isApplication(draft.application) ? draft.application : null),
      source: 'admin',
      issues: [],
    };
  }

  const type = fixedType ?? (isProductType(draft.product_type) ? draft.product_type : null);
  const application = type
    ? (typeApplication(type) ?? (isApplication(draft.application) ? draft.application : null))
    : isApplication(draft.application)
      ? draft.application
      : null;

  return {
    product_type: type,
    application,
    source: fixedType ? 'category' : 'ai',
    issues: productTypeIssues(product.name, type),
  };
}

/**
 * Converts the model's draft into a `_wwc_*` patch. `verification_status`
 * goes straight to `verified` — direct labeling, no review step, by explicit
 * store-owner decision. `ai_generated` stays true so this is still honestly
 * distinguishable from a human approval, and `verified_by_pharmacist` is
 * never set by this path — that field only ever means an actual pharmacist
 * reviewer did it, which didn't happen here.
 *
 * `existingNameAr` is the product's current `name_ar` — when it's already
 * set, that only ever means a real WPML translation exists (`name_ar` is
 * never written by anything else on the sync side, see
 * `products/repository.ts`), so `name_ar` is left out of the patch entirely
 * rather than overwritten with the model's own guess. `updateWwcFields()`
 * never touches a column that's absent from the patch object.
 */
export function draftToPatch(
  draft: LabelDraft,
  confidence: number,
  requiresReview: boolean,
  existingNameAr: string | null = null,
  extra: { typing?: TypeDecision; howToUseSource?: Bilingual } = {},
) {
  const empty = { en: [] as string[], ar: [] as string[] };
  // The store's own How-to-use field is the source of truth for the card —
  // copied verbatim, with the model's text only filling a side that is empty.
  const source = extra.howToUseSource;
  const howToUse =
    source && (source.en || source.ar)
      ? { en: source.en ?? draft.how_to_use?.en ?? null, ar: source.ar ?? draft.how_to_use?.ar ?? null }
      : (draft.how_to_use ?? { en: null, ar: null });
  return {
    ...(existingNameAr ? {} : { name_ar: draft.name_ar ?? null }),
    ...(extra.typing
      ? {
          product_type: extra.typing.product_type,
          application: extra.typing.application,
          product_type_source: extra.typing.source,
          label_issues: extra.typing.issues,
        }
      : {}),
    concern_primary: draft.concern_primary ?? empty,
    concern_secondary: draft.concern_secondary ?? empty,
    suitable_types: draft.suitable_types ?? empty,
    not_ideal_for: draft.not_ideal_for ?? { en: null, ar: null },
    key_ingredients: draft.key_ingredients ?? [],
    texture_finish: draft.texture_finish ?? { en: null, ar: null },
    fragrance: draft.fragrance ?? 'unspecified',
    fragrance_type: draft.fragrance_type ?? null,
    alcohol: draft.alcohol ?? 'unspecified',
    alcohol_type: draft.alcohol_type ?? null,
    how_to_use: howToUse,
    routine_step: draft.routine_step ?? null,
    routine_time: draft.routine_time ?? null,
    age_suitability: draft.age_suitability ?? 'all',
    age_min: draft.age_min ?? null,
    age_max: draft.age_max ?? null,
    // A pregnancy value the model invented is exactly what the gate exists to
    // stop, so route it to the pharmacist rather than storing free text.
    pregnancy_guidance: requiresReview ? 'refer_to_pharmacist' : (draft.pregnancy_guidance ?? null),
    warnings: draft.warnings ?? { en: null, ar: null },
    synonyms_en: draft.synonyms_en ?? [],
    synonyms_ar: draft.synonyms_ar ?? [],
    ai_generated: true,
    ai_confidence: confidence,
    requires_pharmacist_review: requiresReview,
    verification_status: 'verified' as const,
  };
}

/**
 * The fields a reset should clear — exactly the inverse of `draftToPatch()`,
 * with one deliberate exception: `name_ar`. The database has no record of
 * whether a product's current `name_ar` came from a real WPML translation
 * or an AI guess (both write the same column), so a reset — which must
 * never destroy a real translation — leaves it alone entirely rather than
 * risk wiping one. The cost is that an AI-guessed name (only possible for a
 * product with no WPML translation) can outlive a reset; re-running AI
 * labeling won't regenerate it either, since a non-null `name_ar` reads as
 * "already have something real" (see `draftToPatch()`) — an accepted,
 * narrow tradeoff in favour of never touching real translated content.
 */
const RESET_PATCH = {
  concern_primary: { en: [], ar: [] },
  concern_secondary: { en: [], ar: [] },
  suitable_types: { en: [], ar: [] },
  not_ideal_for: { en: null, ar: null },
  key_ingredients: [],
  texture_finish: { en: null, ar: null },
  fragrance: 'unspecified',
  fragrance_type: null,
  alcohol: 'unspecified',
  alcohol_type: null,
  how_to_use: { en: null, ar: null },
  routine_step: null,
  routine_time: null,
  age_suitability: 'all',
  age_min: null,
  age_max: null,
  pregnancy_guidance: null,
  warnings: { en: null, ar: null },
  synonyms_en: [],
  synonyms_ar: [],
  ai_generated: false,
  ai_confidence: null,
  requires_pharmacist_review: false,
  verification_status: 'unverified' as const,
  product_type: null,
  application: null,
  product_type_source: null,
  label_issues: [],
} as const;

/** What a reset leaves alone: an admin-confirmed type is a human decision, like a verified label. */
const RESET_PATCH_KEEP_TYPE = (() => {
  const { product_type: _t, application: _a, product_type_source: _s, ...rest } = RESET_PATCH;
  void _t;
  void _a;
  void _s;
  return rest;
})();

export async function labelProduct(productId: number): Promise<LabelRunResult> {
  const product = getProduct(productId);
  if (!product) throw new Error(`Product ${productId} is not in the local mirror — run a sync first.`);

  // A human already verified this product: do not overwrite their work.
  if (product.verification_status === 'verified' && !product.ai_generated) {
    throw new Error(`Product ${productId} is human-verified; re-labeling would overwrite verified data.`);
  }

  // The shelf decides which schema and category notes the model gets. It
  // comes from the admin's category map (keyword guessing only for an
  // unmapped category); the product's own type is not known yet — unless an
  // admin already set it, which is then the best evidence there is.
  const category = productShelf(product, { ignoreType: product.product_type_source !== 'admin' });
  const fixedType = resolveFromCategories(product.woo_category_ids).fixedType;

  const { draft, model } = await callLabelingModel(product, category, fixedType);
  const confidence = clampConfidence(draft.confidence);
  const typing = decideType(product, draft, fixedType);

  const gate = evaluatePharmacistGate({
    category,
    text: gateText(product, draft),
    modelFlaggedSensitive: draft.mentions_sensitive_topic === true,
  });

  updateWwcFields(
    productId,
    draftToPatch(draft, confidence, gate.requiresPharmacistReview, product.name_ar, {
      typing,
      howToUseSource: product.how_to_use_source,
    }),
  );

  const draftId = insertDraft(productId, category, draft, confidence, model, true);

  logAudit({
    entity: 'product',
    entityId: String(productId),
    action: 'ai_labeled_auto_verified',
    actor: `openai:${model}`,
    detail: {
      confidence,
      category,
      product_type: typing.product_type,
      type_source: typing.source,
      label_issues: typing.issues,
      gate_reasons: gate.reasons,
    },
  });

  // Re-embed straight away: search reads the labels (type, concerns,
  // ingredients), and an index built before labelling knows none of them.
  const updated = getProduct(productId);
  if (updated) {
    reindexProduct(updated).catch((err) => {
      console.warn(`[labeling] re-embedding product ${productId} failed:`, err instanceof Error ? err.message : err);
    });
  }

  return {
    product_id: productId,
    draft_id: draftId,
    category,
    confidence,
    product_type: typing.product_type,
    label_issues: typing.issues,
    requires_pharmacist_review: gate.requiresPharmacistReview,
    gate_reasons: gate.reasons,
  };
}

function insertDraft(
  productId: number,
  category: ProductCategory | null,
  draft: unknown,
  confidence: number,
  model: string,
  autoVerified = false,
): number {
  const conn = db();
  // A fresh run supersedes any older pending draft for the same product.
  conn
    .prepare(`UPDATE label_drafts SET status = 'superseded' WHERE product_id = ? AND status = 'pending'`)
    .run(productId);
  const now = nowIso();
  const result = conn
    .prepare(
      `INSERT INTO label_drafts (product_id, category, draft_json, confidence, model, status, created_at, reviewed_at, reviewed_by, review_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      productId,
      category,
      toJson(draft),
      confidence,
      model,
      autoVerified ? 'approved' : 'pending',
      now,
      autoVerified ? now : null,
      autoVerified ? 'ai:auto' : null,
      autoVerified ? 'Auto-verified directly by AI labeling — no human review.' : null,
    );
  return Number(result.lastInsertRowid);
}

/**
 * Whether a product has never been through labeling and is safe to send to
 * the model. This is unconditional, not an opt-in flag: a product that
 * already carries an AI draft (`ai_generated = true`) — auto-verified,
 * rejected, or superseded, it doesn't matter which — is skipped, and so is
 * anything a human has separately verified or partially approved. The only
 * products this lets through are ones nobody and nothing has ever touched.
 *
 * Exported as a pure function so it's testable without a database or OpenAI —
 * this is the exact rule a re-run after an interrupted or accidental batch
 * relies on to never re-spend on the same product twice.
 */
export function isEligibleForLabeling(p: Pick<Product, 'ai_generated' | 'verification_status'>): boolean {
  return !p.ai_generated && p.verification_status === 'unverified';
}

export interface BackfillOptions {
  limit?: number;
  onProgress?: (done: number, total: number, last: LabelRunResult | Error) => void;
}

/** Batch labeling run over the whole catalogue (roadmap phase 3). */
export async function labelCatalogue(opts: BackfillOptions = {}): Promise<{
  labeled: number;
  failed: number;
  errors: { product_id: number; message: string }[];
}> {
  let products = allProducts().filter(isEligibleForLabeling);

  if (opts.limit) products = products.slice(0, opts.limit);

  let labeled = 0;
  let failed = 0;
  const errors: { product_id: number; message: string }[] = [];

  for (const product of products) {
    try {
      const result = await labelProduct(product.product_id);
      labeled += 1;
      opts.onProgress?.(labeled + failed, products.length, result);
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ product_id: product.product_id, message });
      opts.onProgress?.(labeled + failed, products.length, err instanceof Error ? err : new Error(message));
    }
  }

  return { labeled, failed, errors };
}

/**
 * Wipes every unreviewed AI draft back to a clean, never-labeled state — for
 * discarding a labeling run that went wrong (wrong model, ran unbounded,
 * whatever). Since labeling now writes straight to `verified`, this mostly
 * only ever finds the category-unresolved leftovers (the one case that still
 * lands as `unverified` — see `labelProduct()`), or anything left over from
 * before direct labeling shipped.
 *
 * The one invariant this can never violate: a product marked `verified` or
 * `partial` — by AI or a human — is untouched, full stop. The query below
 * only ever selects `ai_generated = 1` products that are still `unverified`.
 */
export function resetUnreviewedLabels(
  actor?: string,
  conn: DatabaseSync = db(),
): { products_reset: number; drafts_removed: number } {
  const targets = conn
    .prepare(
      `SELECT product_id, product_type_source FROM products WHERE ai_generated = 1 AND verification_status = 'unverified'`,
    )
    .all() as { product_id: number; product_type_source: string | null }[];

  for (const { product_id, product_type_source } of targets) {
    updateWwcFields(product_id, product_type_source === 'admin' ? RESET_PATCH_KEEP_TYPE : RESET_PATCH, conn);
  }

  let draftsRemoved = 0;
  if (targets.length > 0) {
    const placeholders = targets.map(() => '?').join(',');
    const ids = targets.map((t) => t.product_id);
    const result = conn
      .prepare(`DELETE FROM label_drafts WHERE product_id IN (${placeholders})`)
      .run(...ids);
    draftsRemoved = Number(result.changes ?? 0);
  }

  logAudit(
    {
      entity: 'product',
      entityId: 'bulk',
      action: 'ai_labels_reset',
      actor,
      detail: { products_reset: targets.length, drafts_removed: draftsRemoved },
    },
    conn,
  );

  return { products_reset: targets.length, drafts_removed: draftsRemoved };
}

/**
 * Wipes AI-generated labels back to a clean, never-labeled state — verified
 * and partial included, not just unreviewed leftovers — so the catalogue can
 * be relabeled from scratch (new prompt, new model, or the store owner just
 * wants a do-over). This is the deliberately destructive sibling of
 * `resetUnreviewedLabels()`.
 *
 * By default, a product a human verified themselves (`ai_generated = 0`) is
 * left alone — that data was never "training," it's someone's own writing.
 * Pass `includeHumanVerified: true` for a true, no-exceptions fresh start
 * that also wipes those — an explicit, opt-in choice at the call site (the WP
 * dashboard surfaces it as a separate checkbox, not the default action),
 * since it discards content nobody can regenerate from a button click.
 */
export function resetAllAiLabels(
  actor?: string,
  conn: DatabaseSync = db(),
  options: { includeHumanVerified?: boolean } = {},
): { products_reset: number; drafts_removed: number } {
  const targets = options.includeHumanVerified
    ? (conn.prepare(`SELECT product_id, product_type_source FROM products`).all() as {
        product_id: number;
        product_type_source: string | null;
      }[])
    : (conn
        .prepare(`SELECT product_id, product_type_source FROM products WHERE ai_generated = 1`)
        .all() as { product_id: number; product_type_source: string | null }[]);

  // An admin-confirmed product type survives a reset unless the caller asked
  // for a true fresh start — it is a human decision, like a verified label.
  for (const { product_id, product_type_source } of targets) {
    const keepType = product_type_source === 'admin' && !options.includeHumanVerified;
    updateWwcFields(product_id, keepType ? RESET_PATCH_KEEP_TYPE : RESET_PATCH, conn);
  }

  let draftsRemoved = 0;
  if (targets.length > 0) {
    const placeholders = targets.map(() => '?').join(',');
    const ids = targets.map((t) => t.product_id);
    const result = conn
      .prepare(`DELETE FROM label_drafts WHERE product_id IN (${placeholders})`)
      .run(...ids);
    draftsRemoved = Number(result.changes ?? 0);
  }

  logAudit(
    {
      entity: 'product',
      entityId: 'bulk',
      action: 'ai_labels_reset_all',
      actor,
      detail: {
        products_reset: targets.length,
        drafts_removed: draftsRemoved,
        included_human_verified: options.includeHumanVerified === true,
      },
    },
    conn,
  );

  return { products_reset: targets.length, drafts_removed: draftsRemoved };
}

/**
 * One-time migration: flips every currently-pending label draft straight to
 * `verified`, sight-unseen — including low-confidence and category-unresolved
 * ones. This mirrors, in bulk, what `labelProduct()` now does for every new
 * label going forward; it exists only to bring drafts created before direct
 * labeling shipped up to the same state. Explicit, confirmed store-owner
 * decision — not something to run more than once per deployment.
 *
 * A category-unresolved draft (`category` null, no real generated fields —
 * see `labelProduct()`) gets verified with whatever the product already had
 * stored, same as everything else here; it is not special-cased.
 */
export function autoVerifyPendingDrafts(
  actor?: string,
  conn: DatabaseSync = db(),
): { verified: number } {
  const pending = conn
    .prepare(`SELECT id, product_id FROM label_drafts WHERE status = 'pending'`)
    .all() as { id: number; product_id: number }[];

  const now = nowIso();
  for (const { id, product_id } of pending) {
    updateWwcFields(product_id, { verification_status: 'verified' }, conn);
    conn
      .prepare(
        `UPDATE label_drafts SET status = 'approved', reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ?`,
      )
      .run(now, actor ?? 'ai:auto', 'Bulk auto-verified — direct-labeling migration.', id);
  }

  logAudit(
    {
      entity: 'product',
      entityId: 'bulk',
      action: 'ai_labels_auto_verified_bulk',
      actor,
      detail: { count: pending.length },
    },
    conn,
  );

  return { verified: pending.length };
}

// --- Review queue -----------------------------------------------------------

export interface QueueRow {
  draft_id: number;
  product_id: number;
  name: string;
  image_url: string | null;
  category: string | null;
  confidence: number | null;
  requires_pharmacist_review: boolean;
  verification_status: string;
  created_at: string;
  draft: LabelDraft;
  low_confidence: boolean;
}

/** Label Review Queue data, lowest confidence first (spec §3.3 step 6). */
export function reviewQueue(limit = 50, offset = 0): QueueRow[] {
  const rows = db()
    .prepare(
      `SELECT d.id AS draft_id, d.product_id, d.category, d.confidence, d.draft_json, d.created_at,
              p.name, p.image_url, p.requires_pharmacist_review, p.verification_status
         FROM label_drafts d
         JOIN products p ON p.product_id = d.product_id
        WHERE d.status = 'pending'
        ORDER BY COALESCE(d.confidence, 0) ASC, d.created_at ASC
        LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as Record<string, unknown>[];

  return rows.map((r) => {
    const confidence = r.confidence === null || r.confidence === undefined ? null : Number(r.confidence);
    return {
      draft_id: Number(r.draft_id),
      product_id: Number(r.product_id),
      name: String(r.name ?? ''),
      image_url: (r.image_url as string) ?? null,
      category: (r.category as string) ?? null,
      confidence,
      requires_pharmacist_review: Number(r.requires_pharmacist_review ?? 0) === 1,
      verification_status: String(r.verification_status ?? 'unverified'),
      created_at: String(r.created_at ?? ''),
      draft: JSON.parse(String(r.draft_json ?? '{}')) as LabelDraft,
      low_confidence: confidence !== null && confidence < config.labeling.confidenceThreshold,
    };
  });
}

export interface ReviewDecision {
  draftId: number;
  action: 'approve' | 'reject';
  /** `verified` or `partial` — the only two states a human approval can set. */
  status?: 'verified' | 'partial';
  /** Field-level edits the reviewer made before approving. */
  edits?: Record<string, unknown>;
  reviewer: string;
  /** True only when the WP layer confirmed the `wwc_pharmacist_review` cap. */
  reviewerIsPharmacist: boolean;
  note?: string;
}

/**
 * Applies a human review decision. This is the ONLY path to `verified`. Any
 * admin may approve any product, including one flagged `requires_pharmacist_review`
 * (vitamins/supplements, pregnancy/children/medicine mentions) — pharmacist
 * review is informational, not a requirement. `verified_by_pharmacist` below
 * still only ever records whether an actual pharmacist reviewer did it.
 */
export function applyReview(
  decision: ReviewDecision,
  conn: DatabaseSync = db(),
): { product_id: number; status: string } {
  const row = conn
    .prepare(`SELECT product_id FROM label_drafts WHERE id = ? AND status = 'pending'`)
    .get(decision.draftId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`No pending label draft with id ${decision.draftId}`);

  const productId = Number(row.product_id);
  const product = getProduct(productId, conn);
  if (!product) throw new Error(`Product ${productId} no longer exists`);

  if (decision.action === 'reject') {
    conn
      .prepare(
        `UPDATE label_drafts SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ?`,
      )
      .run(nowIso(), decision.reviewer, decision.note ?? null, decision.draftId);
    logAudit(
      {
        entity: 'label_draft',
        entityId: String(decision.draftId),
        action: 'rejected',
        actor: decision.reviewer,
        detail: { product_id: productId, note: decision.note ?? null },
      },
      conn,
    );
    return { product_id: productId, status: product.verification_status };
  }

  const status = decision.status ?? 'verified';

  const patch: Record<string, unknown> = { ...(decision.edits ?? {}) };
  if ('product_type' in patch) {
    // A reviewer's type choice is an admin decision like any other — see
    // setProductTypeByAdmin().
    if (isProductType(patch.product_type)) {
      patch.application = typeApplication(patch.product_type) ?? product.application;
      patch.product_type_source = 'admin';
      patch.label_issues = [];
    } else {
      delete patch.product_type;
    }
  }
  patch.verification_status = status;
  patch.ai_generated = false; // a human now owns these values
  patch.source_verification_date = nowIso().slice(0, 10);
  patch.source_verification_note = decision.note ?? `Approved by ${decision.reviewer}`;
  if (decision.reviewerIsPharmacist && status === 'verified') {
    patch.verified_by_pharmacist = true;
  }

  updateWwcFields(productId, patch, conn);

  conn
    .prepare(
      `UPDATE label_drafts SET status = 'approved', reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ?`,
    )
    .run(nowIso(), decision.reviewer, decision.note ?? null, decision.draftId);

  logAudit(
    {
      entity: 'product',
      entityId: String(productId),
      action: `verified:${status}`,
      actor: decision.reviewer,
      detail: {
        pharmacist: decision.reviewerIsPharmacist,
        edited_fields: Object.keys(decision.edits ?? {}),
      },
    },
    conn,
  );

  return { product_id: productId, status };
}

/**
 * An admin's product-type correction, from the Accuracy screen. Marked
 * `admin` so no relabel or ordinary reset ever overwrites it, and clears any
 * label issues — the admin looking at the product and choosing IS the
 * resolution those issues were asking for.
 */
export function setProductTypeByAdmin(
  productId: number,
  type: ProductType,
  actor: string | undefined,
  conn: DatabaseSync = db(),
): Product {
  const product = getProduct(productId, conn);
  if (!product) throw new Error(`Product ${productId} not found`);
  const before = product.product_type;

  updateWwcFields(
    productId,
    {
      product_type: type,
      application: typeApplication(type) ?? product.application,
      product_type_source: 'admin',
      label_issues: [],
    },
    conn,
  );

  logAudit(
    {
      entity: 'product',
      entityId: String(productId),
      action: 'product_type_set',
      actor,
      detail: { from: before, to: type },
    },
    conn,
  );

  return getProduct(productId, conn)!;
}
