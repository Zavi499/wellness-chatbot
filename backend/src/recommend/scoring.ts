/**
 * The 100-point scoring model (spec §4.6).
 *
 * Weights are exactly as specified; each criterion returns 0–1 and is
 * multiplied by its weight. The breakdown is kept so the widget's "Why this?"
 * panel and the admin can both see how a result was reached — an unexplainable
 * recommendation is a defect, not a feature.
 */
import { normalizeQuery } from '../search/normalize.js';
import type { Product } from '../types.js';
import type { CustomerProfile } from './profile.js';

export const WEIGHTS = {
  concern_match: 30,
  type_compatibility: 20,
  sensitivity_safety: 15,
  preference_match: 10,
  budget_value: 10,
  customer_rating: 5,
  availability: 5,
  diversity: 5,
} as const;

export type ScoreKey = keyof typeof WEIGHTS;

export interface ScoredProduct {
  product: Product;
  score: number;
  breakdown: Record<ScoreKey, number>;
  reasons: string[];
}

/** Reviews only count once there are enough of them to mean anything (§4.6). */
const MIN_REVIEWS_TO_COUNT = 5;

function listIncludes(list: string[], needle: string | null): boolean {
  if (!needle) return false;
  const target = normalizeQuery(needle.replace(/_/g, ' '));
  return list.some((item) => {
    const n = normalizeQuery(item);
    return n.includes(target) || target.includes(n);
  });
}

function concernScore(product: Product, profile: CustomerProfile): number {
  const primary = [...product.concern_primary.en, ...product.concern_primary.ar];
  const secondary = [...product.concern_secondary.en, ...product.concern_secondary.ar];

  let score = 0;
  if (listIncludes(primary, profile.concern_primary)) score = 1;
  else if (listIncludes(secondary, profile.concern_primary)) score = 0.6;
  else if (profile.concern_primary === null) score = 0.5; // no stated concern — neutral

  // A secondary-concern hit is a bonus, never enough on its own.
  if (profile.concern_secondary && (listIncludes(primary, profile.concern_secondary) || listIncludes(secondary, profile.concern_secondary))) {
    score = Math.min(1, score + 0.2);
  }
  return score;
}

function typeScore(product: Product, profile: CustomerProfile): number {
  const suitable = [...product.suitable_types.en, ...product.suitable_types.ar];
  if (suitable.length === 0) return 0.4; // unknown, not disqualifying
  if (profile.types.length === 0) return 0.5;

  const hits = profile.types.filter((t) => listIncludes(suitable, t)).length;
  if (hits === 0) return 0.2;
  return Math.min(1, 0.5 + hits / profile.types.length / 2);
}

function sensitivityScore(product: Product, profile: CustomerProfile): number {
  let score = 0.6; // neutral baseline

  if (profile.sensitivity === 'very') {
    if (product.fragrance === 'no') score += 0.2;
    if (product.fragrance === 'yes') score -= 0.35;
    if (product.alcohol === 'no') score += 0.15;
    if (product.alcohol === 'yes') score -= 0.3;
    if (listIncludes([...product.suitable_types.en, ...product.suitable_types.ar], 'sensitive')) score += 0.25;
  } else if (profile.sensitivity === 'somewhat') {
    if (product.fragrance === 'yes') score -= 0.1;
    if (product.alcohol === 'yes') score -= 0.1;
  }

  // Any warning text at all is a mild caution, not a rejection.
  if (product.warnings.en || product.warnings.ar) score -= 0.05;

  // Products a pharmacist has verified are the safest choice for a child.
  if (profile.for_child) {
    if (product.age_suitability === 'child' || product.age_suitability === 'all') score += 0.2;
    if (product.verified_by_pharmacist) score += 0.1;
  }

  return Math.min(1, Math.max(0, score));
}

function preferenceScore(product: Product, profile: CustomerProfile): number {
  let score = 0.5;
  let signals = 0;

  if (profile.texture_preference) {
    signals += 1;
    const texture = [product.texture_finish.en, product.texture_finish.ar].filter(Boolean).join(' ');
    if (texture && listIncludes([texture], profile.texture_preference)) score += 0.3;
  }

  if (profile.fragrance_preference === 'fragrance_free' && product.fragrance === 'no') {
    signals += 1;
    score += 0.2;
  }
  if (profile.fragrance_preference === 'love_scent' && product.fragrance === 'yes') {
    signals += 1;
    score += 0.1;
  }

  // "Fast/simple routine" prefers multi-step-free products.
  if (profile.priority === 'simple' && product.routine_time === 'both') score += 0.1;
  if (profile.priority === 'gentle' && product.fragrance === 'no') score += 0.1;

  if (signals === 0) return 0.5;
  return Math.min(1, Math.max(0, score));
}

/** Price bands in KWD, tuned for this store's catalogue; adjustable if pricing shifts. */
const BUDGET_BANDS: Record<'low' | 'mid' | 'high', [number, number]> = {
  low: [0, 8],
  mid: [8, 20],
  high: [20, Number.POSITIVE_INFINITY],
};

function parseSizeMl(size: string | null): number | null {
  if (!size) return null;
  const m = size.match(/(\d+(?:\.\d+)?)\s*(ml|g|l|kg)/i);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  if (!Number.isFinite(value)) return null;
  if (unit === 'l' || unit === 'kg') return value * 1000;
  return value;
}

/** Cost per unit volume, when both price and a parseable size exist. */
export function costPerUse(product: Product): number | null {
  const ml = parseSizeMl(product.size);
  if (!ml || !product.price) return null;
  return product.price / ml;
}

function budgetScore(product: Product, profile: CustomerProfile, catalogue: Product[]): number {
  if (product.price === null) return 0.4;
  if (profile.budget === 'any') return 0.6;

  const [min, max] = BUDGET_BANDS[profile.budget];
  let score = product.price >= min && product.price < max ? 1 : 0.3;

  // Reward better cost-per-use within the eligible set.
  const cpu = costPerUse(product);
  if (cpu !== null) {
    const all = catalogue.map(costPerUse).filter((v): v is number => v !== null);
    if (all.length > 1) {
      const best = Math.min(...all);
      const worst = Math.max(...all);
      if (worst > best) score = Math.min(1, score + 0.2 * (1 - (cpu - best) / (worst - best)));
    }
  }
  return Math.min(1, score);
}

function ratingScore(product: Product): number {
  if (product.rating_count < MIN_REVIEWS_TO_COUNT || product.rating_average === null) return 0.5;
  return Math.min(1, Math.max(0, (product.rating_average - 1) / 4));
}

function availabilityScore(product: Product): number {
  if (product.stock_status === 'instock') return 1;
  if (product.stock_status === 'onbackorder') return 0.3;
  return 0;
}

/** A product's "shape" — two products with the same fingerprint are near-duplicates. */
export function formulaFingerprint(product: Product): string {
  return [
    product.routine_step ?? '',
    normalizeQuery(product.texture_finish.en ?? ''),
    product.key_ingredients.slice(0, 3).map(normalizeQuery).sort().join('|'),
    product.brand ? normalizeQuery(product.brand) : '',
  ].join('::');
}

/**
 * Strategic diversity: penalise a candidate that looks like something already
 * chosen, so the final three are meaningfully different (spec §4.6).
 */
function diversityScore(product: Product, alreadyChosen: Product[]): number {
  if (alreadyChosen.length === 0) return 1;
  const fingerprint = formulaFingerprint(product);
  let penalty = 0;
  for (const other of alreadyChosen) {
    const otherPrint = formulaFingerprint(other);
    if (otherPrint === fingerprint) penalty += 0.6;
    else {
      if (other.brand && product.brand && normalizeQuery(other.brand) === normalizeQuery(product.brand)) penalty += 0.2;
      if (other.routine_step && other.routine_step === product.routine_step) penalty += 0.1;
      const shared = product.key_ingredients.filter((i) =>
        other.key_ingredients.some((j) => normalizeQuery(i) === normalizeQuery(j)),
      ).length;
      if (shared >= 2) penalty += 0.2;
    }
  }
  return Math.max(0, 1 - penalty);
}

function buildReasons(product: Product, profile: CustomerProfile, breakdown: Record<ScoreKey, number>): string[] {
  const reasons: string[] = [];
  if (breakdown.concern_match >= WEIGHTS.concern_match * 0.8 && profile.concern_primary) {
    reasons.push(`Targets ${profile.concern_primary.replace(/_/g, ' ')}, which you told me matters most`);
  }
  if (breakdown.type_compatibility >= WEIGHTS.type_compatibility * 0.7 && profile.types.length) {
    reasons.push(`Formulated for ${profile.types.map((t) => t.replace(/_/g, ' ')).join(' / ')}`);
  }
  if (profile.sensitivity === 'very' && product.fragrance === 'no') {
    reasons.push('Fragrance-free, which suits skin that reacts easily');
  }
  if (profile.budget !== 'any' && breakdown.budget_value >= WEIGHTS.budget_value * 0.8) {
    reasons.push('Sits inside the budget you chose');
  }
  if (product.key_ingredients.length) {
    reasons.push(`Key ingredients: ${product.key_ingredients.slice(0, 3).join(', ')}`);
  }
  return reasons.slice(0, 3);
}

export function scoreProduct(
  product: Product,
  profile: CustomerProfile,
  catalogue: Product[],
  alreadyChosen: Product[] = [],
): ScoredProduct {
  const breakdown: Record<ScoreKey, number> = {
    concern_match: concernScore(product, profile) * WEIGHTS.concern_match,
    type_compatibility: typeScore(product, profile) * WEIGHTS.type_compatibility,
    sensitivity_safety: sensitivityScore(product, profile) * WEIGHTS.sensitivity_safety,
    preference_match: preferenceScore(product, profile) * WEIGHTS.preference_match,
    budget_value: budgetScore(product, profile, catalogue) * WEIGHTS.budget_value,
    customer_rating: ratingScore(product) * WEIGHTS.customer_rating,
    availability: availabilityScore(product) * WEIGHTS.availability,
    diversity: diversityScore(product, alreadyChosen) * WEIGHTS.diversity,
  };

  const rounded = Object.fromEntries(
    Object.entries(breakdown).map(([k, v]) => [k, Math.round(v * 10) / 10]),
  ) as Record<ScoreKey, number>;

  const score = Math.round(Object.values(breakdown).reduce((a, b) => a + b, 0) * 10) / 10;

  return { product, score, breakdown: rounded, reasons: buildReasons(product, profile, rounded) };
}

export function scoreAll(
  products: Product[],
  profile: CustomerProfile,
  alreadyChosen: Product[] = [],
): ScoredProduct[] {
  return products
    .map((p) => scoreProduct(p, profile, products, alreadyChosen))
    .sort((a, b) => b.score - a.score);
}
