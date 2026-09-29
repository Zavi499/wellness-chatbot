/**
 * "Suggest me a shampoo for dry skin" → exactly shampoos, best match first.
 *
 * This is the path for a customer who says what they want in their own
 * words. The chat model's job is only to turn the sentence into a structured
 * request (`find_products` in chat/tools.ts); everything after that is
 * deterministic, testable code:
 *
 *   1. HARD filter on product type — the customer said shampoo, so only
 *      shampoos are candidates. No similarity score can bring back a tablet.
 *   2. The same eligibility rules as every recommendation (verified, in
 *      stock, not a medicine, no label conflict, no avoided ingredient).
 *   3. Prefer the shampoos whose labels actually match the need ("dry").
 *      If none do, show other shampoos and say so plainly — never a
 *      different type (store owner's decision).
 *   4. Rank with the existing 100-point scorer and pick up to three.
 */
import { allProducts } from '../products/repository.js';
import { isProductType, typeLabel, typeShelf, type ProductType } from '../products/types.js';
import { filterEligible } from './eligibility.js';
import { labelMatches } from './match.js';
import { selectTopThree, type SelectionResult } from './select.js';
import type { BudgetBand, CustomerProfile } from './profile.js';
import type { Language, Product } from '../types.js';

export interface FindRequest {
  product_types: string[];
  /** What it is for: dryness, dandruff, acne … in the customer's words or the lexicon's. */
  concerns?: string[];
  /** Who / what it must suit: dry, oily, curly, sensitive, coloured … */
  for_types?: string[];
  ingredients_wanted?: string[];
  ingredients_avoid?: string[];
  fragrance_free?: boolean;
  budget?: BudgetBand;
  exclude_ids?: number[];
}

export type FindStatus =
  /** Products of the type that match the need. */
  | 'matched'
  /** Products of the type exist, but none is labelled for the need — showing the type anyway. */
  | 'type_only'
  /** The store has nothing of that type that can be recommended. */
  | 'none_of_type'
  /** No product type was given; the customer must be asked. */
  | 'need_type'
  /** A medicine was requested — never recommended, only found by name. */
  | 'medicine';

export interface FindResult {
  status: FindStatus;
  types: ProductType[];
  selection: SelectionResult | null;
  /** How many eligible products of the requested type(s) exist. */
  eligible_of_type: number;
  /** How many of those match the stated need. */
  matching_need: number;
}

/** Customer avoid words → the eligibility filter's known groups; anything else is matched literally. */
const AVOID_GROUPS: [RegExp, string][] = [
  [/fragrance|perfume|parfum|scent|عطر/i, 'fragrance'],
  [/alcohol|كحول/i, 'alcohol'],
  [/retin/i, 'retinol'],
  [/\bacids?\b|aha|bha|glycolic|salicylic|حمض/i, 'acids'],
  [/sulfate|sulphate|sls|سلفات/i, 'sulfate_free'],
  [/silicone|dimethicone|سيليكون/i, 'silicone_free'],
];

function avoidKeys(terms: string[]): string[] {
  const keys = new Set<string>();
  for (const t of terms) {
    const group = AVOID_GROUPS.find(([re]) => re.test(t));
    keys.add(group ? group[1] : t.trim().toLowerCase());
  }
  return [...keys].filter(Boolean);
}

export function profileForRequest(req: FindRequest, types: ProductType[]): CustomerProfile {
  const concerns = (req.concerns ?? []).filter(Boolean);
  return {
    category: typeShelf(types[0]!),
    product_type: types[0] ?? null,
    product_types: types,
    types: (req.for_types ?? []).filter(Boolean),
    concern_primary: concerns[0] ?? null,
    concern_secondary: concerns[1] ?? null,
    sensitivity: (req.for_types ?? []).some((t) => /sensitive|حساس/i.test(t)) ? 'very' : 'unknown',
    texture_preference: null,
    fragrance_preference: req.fragrance_free ? 'fragrance_free' : null,
    avoid: avoidKeys([...(req.ingredients_avoid ?? []), ...(req.fragrance_free ? ['fragrance'] : [])]),
    current_actives: [],
    budget: req.budget ?? 'any',
    priority: null,
    who_for: null,
    area_of_use: null,
    for_child: false,
  };
}

/**
 * How many of the stated needs a product's labels (and its name) actually
 * mention. Zero means "right type, but nothing says it's for this".
 */
export function needHits(product: Product, req: FindRequest): number {
  const concernLabels = [
    ...product.concern_primary.en,
    ...product.concern_primary.ar,
    ...product.concern_secondary.en,
    ...product.concern_secondary.ar,
  ];
  const suitLabels = [...product.suitable_types.en, ...product.suitable_types.ar];
  const nameAndSummary = [product.name, product.name_ar, product.short_description];
  const ingredientText = [...product.key_ingredients, product.full_ingredients];

  let hits = 0;
  for (const c of req.concerns ?? []) {
    if (labelMatches([...concernLabels, ...suitLabels, ...nameAndSummary], c)) hits += 1;
  }
  for (const t of req.for_types ?? []) {
    if (labelMatches([...suitLabels, ...concernLabels, ...nameAndSummary], t)) hits += 1;
  }
  for (const i of req.ingredients_wanted ?? []) {
    if (labelMatches(ingredientText, i)) hits += 1;
  }
  return hits;
}

function hasNeed(req: FindRequest): boolean {
  return (
    (req.concerns ?? []).length + (req.for_types ?? []).length + (req.ingredients_wanted ?? []).length > 0
  );
}

export function findProducts(req: FindRequest, opts: { catalogue?: Product[] } = {}): FindResult {
  const types = [...new Set((req.product_types ?? []).filter(isProductType))];
  const empty = { selection: null, eligible_of_type: 0, matching_need: 0 };

  if (types.length === 0) return { status: 'need_type', types, ...empty };
  if (types.includes('medicine')) return { status: 'medicine', types, ...empty };

  const catalogue = opts.catalogue ?? allProducts();
  const profile = profileForRequest(req, types);
  const { eligible } = filterEligible(catalogue, profile, { excludeIds: req.exclude_ids });

  if (eligible.length === 0) return { status: 'none_of_type', types, ...empty };

  if (!hasNeed(req)) {
    return {
      status: 'matched',
      types,
      selection: selectTopThree(profile, { catalogue: eligible }),
      eligible_of_type: eligible.length,
      matching_need: eligible.length,
    };
  }

  // Rank the best need-match first: a product that mentions two of the
  // customer's needs beats one that mentions one, before scoring even starts.
  const scored = eligible.map((p) => ({ p, hits: needHits(p, req) }));
  const best = Math.max(...scored.map((s) => s.hits));
  const matching = scored.filter((s) => s.hits > 0);

  if (best === 0) {
    return {
      status: 'type_only',
      types,
      selection: selectTopThree(profile, { catalogue: eligible }),
      eligible_of_type: eligible.length,
      matching_need: 0,
    };
  }

  const top = scored.filter((s) => s.hits === best).map((s) => s.p);
  // Fewer than three at the top hit count: widen to every product that
  // matches the need at all, so the customer still gets alternatives — all
  // of them genuinely relevant.
  const pool = top.length >= 3 ? top : matching.map((s) => s.p);

  return {
    status: 'matched',
    types,
    selection: selectTopThree(profile, { catalogue: pool }),
    eligible_of_type: eligible.length,
    matching_need: matching.length,
  };
}

const TYPE_ONLY_NOTE: Record<Language, (types: string, need: string) => string> = {
  en: (types, need) =>
    `None of our ${types} products is specifically described for ${need}, so these are the closest ${types} options we have.`,
  ar: (types, need) => `لا يوجد لدينا منتج من فئة ${types} موصوف تحديداً لـ ${need}، لذلك هذه أقرب الخيارات المتوفرة من نفس الفئة.`,
};

/** The honest note shown under the cards when the type matched but the need didn't. */
export function typeOnlyNote(req: FindRequest, types: ProductType[], language: Language): string {
  const typeNames = types.map((t) => typeLabel(t, language).toLowerCase()).join(language === 'ar' ? ' / ' : ' / ');
  const need = [...(req.concerns ?? []), ...(req.for_types ?? []), ...(req.ingredients_wanted ?? [])]
    .map((s) => s.replace(/_/g, ' '))
    .join(language === 'ar' ? '، ' : ', ');
  return TYPE_ONLY_NOTE[language](typeNames, need);
}
