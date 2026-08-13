/**
 * AI auto-labeling pipeline (spec §3.3).
 *
 * Flow: fetch product → structured-output call → write as an UNVERIFIED draft →
 * apply the pharmacist gate → queue for human review. Nothing in this file can
 * produce a `verified` product; only an authenticated human action can (§11).
 */
import { db, nowIso, toJson } from '../db/index.js';
import { openai, models } from '../openai/client.js';
import { config } from '../config.js';
import { getProduct, updateWwcFields, allProducts } from '../products/repository.js';
import { resolveProductCategory, type ProductCategory } from '../products/category.js';
import { labelingSystemPrompt, labelingUserPrompt } from './prompts.js';
import { LABEL_SCHEMAS, type LabelDraft } from './schemas.js';
import { evaluatePharmacistGate } from './gate.js';
import { logAudit } from '../analytics/audit.js';
import type { Product } from '../types.js';

export interface LabelRunResult {
  product_id: number;
  draft_id: number;
  category: ProductCategory;
  confidence: number;
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
          categoryNames: product.categories,
          description: product.description,
          shortDescription: product.short_description,
          attributes: product.tags.length ? product.tags.join(', ') : null,
          ingredientsRaw: product.full_ingredients,
          brand: product.brand,
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

/**
 * Converts the model's draft into a `_wwc_*` patch. Note what is NOT here:
 * `verification_status` never becomes verified, and `verified_by_pharmacist`
 * is never set by this path.
 */
export function draftToPatch(draft: LabelDraft, confidence: number, requiresReview: boolean) {
  const empty = { en: [] as string[], ar: [] as string[] };
  return {
    name_ar: draft.name_ar ?? null,
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
    how_to_use: draft.how_to_use ?? { en: null, ar: null },
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
    verification_status: 'unverified' as const,
  };
}

export async function labelProduct(productId: number): Promise<LabelRunResult> {
  const product = getProduct(productId);
  if (!product) throw new Error(`Product ${productId} is not in the local mirror — run a sync first.`);

  // A human already verified this product: do not overwrite their work.
  if (product.verification_status === 'verified' && !product.ai_generated) {
    throw new Error(`Product ${productId} is human-verified; re-labeling would overwrite verified data.`);
  }

  const category = resolveProductCategory({
    categories: product.categories,
    tags: product.tags,
    name: product.name,
  });

  if (!category) {
    // No guessing. The queue shows this as "needs a category" for a human.
    const draftId = insertDraft(productId, null, { note: 'Category could not be resolved' }, 0, 'n/a');
    updateWwcFields(productId, {
      verification_status: 'unverified',
      ai_generated: true,
      ai_confidence: 0,
      requires_pharmacist_review: false,
    });
    return {
      product_id: productId,
      draft_id: draftId,
      category: 'face',
      confidence: 0,
      requires_pharmacist_review: false,
      gate_reasons: ['Category could not be resolved from the store taxonomy'],
    };
  }

  const { draft, model } = await callLabelingModel(product, category);
  const confidence = clampConfidence(draft.confidence);

  const gate = evaluatePharmacistGate({
    category,
    text: gateText(product, draft),
    modelFlaggedSensitive: draft.mentions_sensitive_topic === true,
  });

  updateWwcFields(productId, draftToPatch(draft, confidence, gate.requiresPharmacistReview));

  const draftId = insertDraft(productId, category, draft, confidence, model);

  logAudit({
    entity: 'product',
    entityId: String(productId),
    action: 'ai_labeled',
    actor: `openai:${model}`,
    detail: { confidence, category, gate_reasons: gate.reasons },
  });

  return {
    product_id: productId,
    draft_id: draftId,
    category,
    confidence,
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
): number {
  const conn = db();
  // A fresh run supersedes any older pending draft for the same product.
  conn
    .prepare(`UPDATE label_drafts SET status = 'superseded' WHERE product_id = ? AND status = 'pending'`)
    .run(productId);
  const result = conn
    .prepare(
      `INSERT INTO label_drafts (product_id, category, draft_json, confidence, model, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(productId, category, toJson(draft), confidence, model, nowIso());
  return Number(result.lastInsertRowid);
}

export interface BackfillOptions {
  /** Skip products that already have a pending draft. */
  skipQueued?: boolean;
  limit?: number;
  onProgress?: (done: number, total: number, last: LabelRunResult | Error) => void;
}

/** Batch labeling run over the whole catalogue (roadmap phase 3). */
export async function labelCatalogue(opts: BackfillOptions = {}): Promise<{
  labeled: number;
  failed: number;
  errors: { product_id: number; message: string }[];
}> {
  const conn = db();
  let products = allProducts();

  if (opts.skipQueued) {
    const queued = new Set(
      (conn.prepare(`SELECT product_id FROM label_drafts WHERE status = 'pending'`).all() as Record<
        string,
        unknown
      >[]).map((r) => Number(r.product_id)),
    );
    products = products.filter((p) => !queued.has(p.product_id));
  }
  // Never re-label human-verified data.
  products = products.filter((p) => !(p.verification_status === 'verified' && !p.ai_generated));

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

export class PharmacistGateError extends Error {
  constructor(productId: number) {
    super(
      `Product ${productId} requires pharmacist review and can only be verified by a user with the wwc_pharmacist_review capability.`,
    );
    this.name = 'PharmacistGateError';
  }
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
 * Applies a human review decision. This is the ONLY path to `verified`, and it
 * re-checks the pharmacist capability server-side — the UI hiding the button is
 * not the control (spec §11).
 */
export function applyReview(decision: ReviewDecision): { product_id: number; status: string } {
  const conn = db();
  const row = conn
    .prepare(`SELECT product_id FROM label_drafts WHERE id = ? AND status = 'pending'`)
    .get(decision.draftId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`No pending label draft with id ${decision.draftId}`);

  const productId = Number(row.product_id);
  const product = getProduct(productId);
  if (!product) throw new Error(`Product ${productId} no longer exists`);

  if (decision.action === 'reject') {
    conn
      .prepare(
        `UPDATE label_drafts SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ?`,
      )
      .run(nowIso(), decision.reviewer, decision.note ?? null, decision.draftId);
    logAudit({
      entity: 'label_draft',
      entityId: String(decision.draftId),
      action: 'rejected',
      actor: decision.reviewer,
      detail: { product_id: productId, note: decision.note ?? null },
    });
    return { product_id: productId, status: product.verification_status };
  }

  const status = decision.status ?? 'verified';

  if (product.requires_pharmacist_review && status === 'verified' && !decision.reviewerIsPharmacist) {
    throw new PharmacistGateError(productId);
  }

  const patch: Record<string, unknown> = { ...(decision.edits ?? {}) };
  patch.verification_status = status;
  patch.ai_generated = false; // a human now owns these values
  patch.source_verification_date = nowIso().slice(0, 10);
  patch.source_verification_note = decision.note ?? `Approved by ${decision.reviewer}`;
  if (decision.reviewerIsPharmacist && status === 'verified') {
    patch.verified_by_pharmacist = true;
  }

  updateWwcFields(productId, patch);

  conn
    .prepare(
      `UPDATE label_drafts SET status = 'approved', reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ?`,
    )
    .run(nowIso(), decision.reviewer, decision.note ?? null, decision.draftId);

  logAudit({
    entity: 'product',
    entityId: String(productId),
    action: `verified:${status}`,
    actor: decision.reviewer,
    detail: {
      pharmacist: decision.reviewerIsPharmacist,
      edited_fields: Object.keys(decision.edits ?? {}),
    },
  });

  return { product_id: productId, status };
}
