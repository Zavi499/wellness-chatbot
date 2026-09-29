/**
 * Recommendation eligibility filter (spec §3.4 and §4.5).
 *
 * This runs BEFORE scoring and is the technical form of the source document's
 * rule that unverified or unsuitable products must never be recommended. Every
 * rejection carries a reason so the admin can see why the catalogue is thin.
 */
import { config } from '../config.js';
import { isMedicineProduct, productShelf } from '../products/category-map.js';
import { normalizeQuery } from '../search/normalize.js';
import type { Product } from '../types.js';
import type { CustomerProfile } from './profile.js';

export type IneligibilityReason =
  | 'out_of_stock'
  | 'not_verified'
  | 'category_mismatch'
  | 'type_mismatch'
  | 'label_conflict'
  | 'not_ideal_for_conflict'
  | 'avoided_ingredient'
  | 'fragrance_conflict'
  | 'alcohol_conflict'
  | 'age_conflict'
  | 'low_confidence'
  | 'medicine'
  | 'excluded';

export interface EligibilityResult {
  eligible: boolean;
  reasons: IneligibilityReason[];
}

/** Words in `_wwc_not_ideal_for` that map onto a customer answer value. */
const CONFLICT_TERMS: Record<string, string[]> = {
  sensitive: ['sensitive', 'حساس'],
  oily: ['oily', 'دهني'],
  dry: ['dry', 'جاف'],
  combination: ['combination', 'مختلط'],
  acne: ['acne', 'حب الشباب'],
  curly: ['curly', 'مجعد'],
  coily: ['coily'],
  fine: ['fine hair', 'شعر خفيف'],
  bleached: ['bleached', 'مبيض'],
  coloured: ['coloured', 'colored', 'مصبوغ'],
  keratin: ['keratin', 'كيراتين'],
};

const AVOID_TERMS: Record<string, string[]> = {
  fragrance: ['fragrance', 'parfum', 'perfume', 'عطر'],
  alcohol: ['alcohol', 'كحول'],
  retinol: ['retinol', 'retinal', 'retinoid', 'ريتينول'],
  acids: ['glycolic', 'salicylic', 'lactic', 'mandelic', 'aha', 'bha', 'حمض'],
  sulfate_free: ['sulfate', 'sls', 'sles', 'سلفات'],
  silicone_free: ['dimethicone', 'silicone', 'siloxane', 'سيليكون'],
  fragrance_free: ['fragrance', 'parfum', 'perfume', 'عطر'],
};

function textOf(product: Product): string {
  return normalizeQuery(
    [
      product.name,
      product.key_ingredients.join(' '),
      product.full_ingredients,
      product.short_description,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

function notIdealText(product: Product): string {
  return normalizeQuery([product.not_ideal_for.en, product.not_ideal_for.ar].filter(Boolean).join(' '));
}

export function checkEligibility(
  product: Product,
  profile: CustomerProfile,
  opts: { excludeIds?: number[] } = {},
): EligibilityResult {
  const reasons: IneligibilityReason[] = [];

  if (opts.excludeIds?.includes(product.product_id)) reasons.push('excluded');

  // 1. Stock. Out-of-stock is never a primary choice (spec §3.4).
  if (product.stock_status === 'outofstock') reasons.push('out_of_stock');

  // 2. Data verification. A product flagged `requires_pharmacist_review`
  // (vitamins/supplements, pregnancy/children/medicine mentions) is held to
  // exactly this same bar as any other product — pharmacist review is
  // informational (see `verified_by_pharmacist`, used only as a scoring
  // signal), not an extra eligibility requirement.
  const acceptable = config.recommendations.allowPartialVerification
    ? ['verified', 'partial']
    : ['verified'];
  if (!acceptable.includes(product.verification_status)) reasons.push('not_verified');

  // 3. Product type — the strictest check there is. When the customer asked
  // for specific types ("shampoo"), a product of any other type is wrong
  // however well it matches the concern, and an untyped product can't be
  // shown to be right. The shelf check is then redundant (a type implies its
  // shelf) and skipped, so a request spanning shelves — face and body
  // sunscreen — isn't cut in half by it.
  const wantedTypes = profile.product_types ?? [];
  if (wantedTypes.length > 0) {
    if (!product.product_type || !wantedTypes.includes(product.product_type)) reasons.push('type_mismatch');
  } else {
    // 3a. Shelf match — from the product's type, the admin's category map,
    // or (unmapped categories only) the old keyword guess.
    if (productShelf(product) !== profile.category) reasons.push('category_mismatch');

    // Something swallowed never answers a hair, face or body request, even
    // when it was filed under "Hair Care".
    if (
      (profile.category === 'hair' || profile.category === 'face' || profile.category === 'body') &&
      product.application === 'oral_ingested'
    ) {
      reasons.push('type_mismatch');
    }
  }

  // 3b. The labelling sanity check found a contradiction (the name says
  // "shampoo", the type says otherwise). Held back until an admin confirms
  // the type on the Accuracy screen — a wrong type is the one mistake a
  // customer spots instantly.
  if ((product.label_issues ?? []).length > 0) reasons.push('label_conflict');

  // 3c. Medicines are findable and purchasable by name (`search_products`)
  // but never ranked into a recommendation, on any shelf. The data needed to
  // do that accurately — indication, dose, contraindications, interactions —
  // is deliberately never collected by labeling. See `isMedicineProduct()`.
  if (isMedicineProduct(product)) reasons.push('medicine');

  // 3d. Confidence floor. A product labeled from a bare title — no
  // description, no attributes — comes back with mostly-null fields and a
  // low self-reported confidence, yet still lands as `verified`. Recommending
  // it is how the catalogue produces confident-looking but baseless matches,
  // so hold AI-labeled products to a minimum score. Human-verified products
  // (`ai_generated = false`) carry no AI confidence and are exempt.
  if (
    product.ai_generated &&
    product.ai_confidence !== null &&
    product.ai_confidence < config.recommendations.minConfidence
  ) {
    reasons.push('low_confidence');
  }

  // 4. `not_ideal_for` conflicts with the customer's stated type or concern.
  const notIdeal = notIdealText(product);
  if (notIdeal) {
    const customerSignals = [
      ...profile.types,
      profile.concern_primary,
      profile.sensitivity === 'very' ? 'sensitive' : null,
    ].filter(Boolean) as string[];

    for (const signal of customerSignals) {
      const terms = CONFLICT_TERMS[signal] ?? [signal.replace(/_/g, ' ')];
      if (terms.some((t) => notIdeal.includes(normalizeQuery(t)))) {
        reasons.push('not_ideal_for_conflict');
        break;
      }
    }
  }

  // 5. Ingredients and formulation the customer asked to avoid.
  const haystack = textOf(product);
  for (const avoid of profile.avoid) {
    // A free-text avoid ("parabens") outside the known groups is matched as written.
    const terms = AVOID_TERMS[avoid] ?? [avoid.replace(/_/g, ' ')];
    if (terms.some((t) => haystack.includes(normalizeQuery(t)))) {
      reasons.push('avoided_ingredient');
      break;
    }
  }

  if (profile.fragrance_preference === 'fragrance_free' && product.fragrance === 'yes') {
    reasons.push('fragrance_conflict');
  }
  if (profile.avoid.includes('alcohol') && product.alcohol === 'yes') {
    reasons.push('alcohol_conflict');
  }

  // 6. Age suitability. An adult-only product is never shown for a child.
  if (profile.for_child && (product.age_suitability === 'adult' || (product.age_min ?? 0) >= 16)) {
    reasons.push('age_conflict');
  }

  return { eligible: reasons.length === 0, reasons };
}

export interface FilterOutcome {
  eligible: Product[];
  rejected: { product: Product; reasons: IneligibilityReason[] }[];
}

export function filterEligible(
  products: Product[],
  profile: CustomerProfile,
  opts: { excludeIds?: number[] } = {},
): FilterOutcome {
  const eligible: Product[] = [];
  const rejected: { product: Product; reasons: IneligibilityReason[] }[] = [];

  for (const product of products) {
    const result = checkEligibility(product, profile, opts);
    if (result.eligible) eligible.push(product);
    else rejected.push({ product, reasons: result.reasons });
  }

  return { eligible, rejected };
}
