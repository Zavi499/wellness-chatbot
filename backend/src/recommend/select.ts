/**
 * Top-three selection (spec §4.6) and the recommendation-card contract (§4.7).
 *
 * Rules that matter: never pad to three with a poor match, never present an
 * out-of-stock product as a primary choice, and keep the three meaningfully
 * different from each other.
 */
import { allProducts, getProducts } from '../products/repository.js';
import { costPerUse, formulaFingerprint, scoreAll, scoreProduct, type ScoredProduct } from './scoring.js';
import { filterEligible, type FilterOutcome } from './eligibility.js';
import type { CustomerProfile } from './profile.js';
import type { Language, Product, RecommendationItem, RecommendationSet } from '../types.js';

export type SlotLabel = 'best_overall' | 'best_value' | 'alternative';

const LABELS: Record<SlotLabel, Record<Language, string>> = {
  best_overall: { en: 'Best Overall Match', ar: 'الأنسب لك' },
  best_value: { en: 'Best Value', ar: 'أفضل قيمة' },
  alternative: { en: 'Alternative Choice', ar: 'خيار بديل' },
};

const DISCLAIMER: Record<Language, string> = {
  en: 'Based on your answers, these are the best matches in our current catalogue.',
  ar: 'بناءً على إجاباتك، هذه هي أفضل الخيارات المتوفرة حالياً في متجرنا.',
};

const SHORTFALL: Record<Language, string> = {
  en: "That's everything in our catalogue that genuinely fits what you described — I'd rather show you fewer good matches than pad the list.",
  ar: 'هذه كل الخيارات التي تناسب فعلاً ما وصفته — أفضّل أن أعرض عليك خيارات أقل لكنها مناسبة بدلاً من إضافة خيارات غير ملائمة.',
};

export interface SelectionResult {
  picks: { slot: SlotLabel; scored: ScoredProduct }[];
  outcome: FilterOutcome;
  shortfall: boolean;
}

/** "Materially" cheaper: at least 15% lower price, or a better cost-per-use. */
function isBetterValue(candidate: Product, reference: Product): boolean {
  if (candidate.price !== null && reference.price !== null && reference.price > 0) {
    if (candidate.price <= reference.price * 0.85) return true;
  }
  const a = costPerUse(candidate);
  const b = costPerUse(reference);
  if (a !== null && b !== null && a < b * 0.9) return true;
  return false;
}

/** Meaningfully different in texture, formulation, tier or gentleness. */
function isMeaningfulAlternative(candidate: Product, chosen: Product[]): boolean {
  const print = formulaFingerprint(candidate);
  if (chosen.some((c) => formulaFingerprint(c) === print)) return false;

  return chosen.every((c) => {
    const differentBrand = (c.brand ?? '') !== (candidate.brand ?? '');
    const differentTexture = (c.texture_finish.en ?? '') !== (candidate.texture_finish.en ?? '');
    const differentGentleness = c.fragrance !== candidate.fragrance;
    const differentTier =
      c.price !== null && candidate.price !== null && Math.abs(c.price - candidate.price) / Math.max(c.price, 1) > 0.3;
    return differentBrand || differentTexture || differentGentleness || differentTier;
  });
}

export function selectTopThree(
  profile: CustomerProfile,
  opts: { excludeIds?: number[]; catalogue?: Product[] } = {},
): SelectionResult {
  const catalogue = opts.catalogue ?? allProducts();
  const outcome = filterEligible(catalogue, profile, { excludeIds: opts.excludeIds });

  if (outcome.eligible.length === 0) {
    return { picks: [], outcome, shortfall: true };
  }

  const ranked = scoreAll(outcome.eligible, profile);
  const picks: { slot: SlotLabel; scored: ScoredProduct }[] = [];

  // 1. Best Overall Match — highest total score.
  const best = ranked[0]!;
  picks.push({ slot: 'best_overall', scored: best });
  const chosen: Product[] = [best.product];

  // 2. Best Value — highest scorer that is materially cheaper / better value.
  const valueCandidates = ranked
    .slice(1)
    .filter((r) => isBetterValue(r.product, best.product))
    .map((r) => scoreProduct(r.product, profile, outcome.eligible, chosen))
    .sort((a, b) => b.score - a.score);

  if (valueCandidates[0]) {
    picks.push({ slot: 'best_value', scored: valueCandidates[0] });
    chosen.push(valueCandidates[0].product);
  }

  // 3. Alternative Choice — highest scorer that differs meaningfully from both.
  const alternativeCandidates = ranked
    .filter((r) => !chosen.some((c) => c.product_id === r.product.product_id))
    .filter((r) => isMeaningfulAlternative(r.product, chosen))
    .map((r) => scoreProduct(r.product, profile, outcome.eligible, chosen))
    .sort((a, b) => b.score - a.score);

  if (alternativeCandidates[0]) {
    picks.push({ slot: 'alternative', scored: alternativeCandidates[0] });
    chosen.push(alternativeCandidates[0].product);
  }

  return { picks, outcome, shortfall: picks.length < 3 };
}

function formatPrice(product: Product): string | null {
  if (product.price === null) return null;
  return `${product.price.toFixed(3)} ${product.currency}`;
}

function pick<T>(value: T | null | undefined, fallback: T): T {
  return value === null || value === undefined ? fallback : value;
}

function localized(bilingual: { en: string | null; ar: string | null }, language: Language): string | null {
  return language === 'ar' ? (bilingual.ar ?? bilingual.en) : (bilingual.en ?? bilingual.ar);
}

export function toRecommendationSet(
  result: SelectionResult,
  language: Language,
  opts: { includeScores?: boolean } = {},
): RecommendationSet {
  const items: RecommendationItem[] = result.picks.map(({ slot, scored }) => {
    const p = scored.product;
    const whatToKnow =
      localized(p.warnings, language) ??
      localized(p.not_ideal_for, language) ??
      (language === 'ar'
        ? 'جرّبيه على منطقة صغيرة أولاً إذا كانت بشرتك حساسة.'
        : 'Patch test first if your skin reacts easily.');

    const item: RecommendationItem = {
      product_id: p.product_id,
      label: LABELS[slot][language],
      name: language === 'ar' ? pick(p.name_ar, p.name) : p.name,
      image_url: p.image_url,
      permalink: p.permalink,
      price: formatPrice(p),
      size: p.size,
      in_stock: p.stock_status === 'instock',
      why_it_suits_you: scored.reasons,
      best_for:
        localized(
          { en: p.concern_primary.en.join(', ') || null, ar: p.concern_primary.ar.join(', ') || null },
          language,
        ) ?? (language === 'ar' ? 'العناية اليومية' : 'Everyday care'),
      what_to_know: whatToKnow,
      how_to_use:
        localized(p.how_to_use, language) ??
        (language === 'ar' ? 'اتبع التعليمات المدوّنة على العبوة.' : 'Follow the directions on the pack.'),
      actions: ['view_product', 'add_to_cart', 'compare', 'replace'],
    };

    if (opts.includeScores) {
      item.score = scored.score;
      item.score_breakdown = scored.breakdown;
    }
    return item;
  });

  const set: RecommendationSet = {
    type: 'recommendation_set',
    items,
    disclaimer: DISCLAIMER[language],
  };
  if (result.shortfall) set.shortfall_note = SHORTFALL[language];
  return set;
}

/**
 * Out-of-stock substitution (spec §3.4): prefer the product's own curated
 * alternatives, then fall back to a fresh scoring pass.
 */
export function substituteOutOfStock(product: Product, profile: CustomerProfile): Product | null {
  if (product.stock_status !== 'outofstock') return product;

  const curated = getProducts(product.alternative_products);
  const { eligible } = filterEligible(curated, profile);
  if (eligible.length) {
    return scoreAll(eligible, profile)[0]?.product ?? null;
  }

  const fresh = selectTopThree(profile, { excludeIds: [product.product_id] });
  return fresh.picks[0]?.scored.product ?? null;
}

/**
 * Routine builder (spec §9.2): turns one product into a simple AM/PM routine
 * from verified, compatible products only.
 */
export function buildRoutine(
  seed: Product,
  profile: CustomerProfile,
): { am: Product[]; pm: Product[] } {
  const catalogue = allProducts();
  const complementary = getProducts(seed.complementary_products);
  const { eligible } = filterEligible(
    complementary.length ? complementary : catalogue,
    { ...profile, concern_primary: profile.concern_primary },
  );

  const byStep = new Map<string, Product>();
  for (const p of [seed, ...scoreAll(eligible, profile).map((s) => s.product)]) {
    const step = p.routine_step ?? 'other';
    if (!byStep.has(step)) byStep.set(step, p);
  }

  const order = ['cleanse', 'tone', 'treat', 'moisturize', 'protect'];
  const am: Product[] = [];
  const pm: Product[] = [];

  for (const step of order) {
    const product = byStep.get(step);
    if (!product) continue;
    const time = product.routine_time ?? 'both';
    if (step === 'protect') {
      am.push(product); // sunscreen is a morning step
      continue;
    }
    if (time === 'am' || time === 'both') am.push(product);
    if (time === 'pm' || time === 'both') pm.push(product);
  }

  return { am, pm };
}
