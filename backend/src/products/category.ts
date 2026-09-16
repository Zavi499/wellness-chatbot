/**
 * Maps a WooCommerce category/tag set onto the four questionnaire categories
 * (spec §4.4). Store taxonomies drift, so this is a keyword mapping the store
 * owner can extend, not a hardcoded taxonomy ID list.
 */
import type { CategoryKey } from '../types.js';

/**
 * The sellable categories; `routine` and `compare` are flows, not shelves.
 *
 * `general` is the catch-all for everything a pharmacy stocks that isn't one
 * of the four consultative shelves — makeup, baby, oral care, first aid,
 * devices, household. It exists because the store's real WooCommerce
 * taxonomy is ~48 categories wide: before it, anything outside the four
 * simply never resolved, never got labeled, and sat in the review queue
 * forever as "category unresolved" with nothing a human could do about it.
 */
export type ProductCategory = 'face' | 'body' | 'hair' | 'vitamins' | 'general';

const RULES: { category: ProductCategory; patterns: RegExp[] }[] = [
  {
    category: 'face',
    patterns: [
      /face/i, /facial/i, /skin ?care/i, /cleanser/i, /face wash/i, /serum/i, /moistur/i,
      /sunscreen/i, /sun ?block/i, /spf/i, /toner/i, /mask/i, /eye cream/i, /acne/i,
      /وجه/, /غسول/, /سيروم/, /واقي شمس/, /مرطب/,
    ],
  },
  {
    category: 'body',
    patterns: [
      /body/i, /bath/i, /shower/i, /deodorant/i, /hand ?cream/i, /foot/i, /heel/i, /lotion/i,
      /intimate/i, /scrub/i, /stretch mark/i,
      /جسم/, /استحمام/, /مزيل عرق/, /لوشن/, /كعب/,
    ],
  },
  {
    category: 'hair',
    patterns: [
      /hair/i, /scalp/i, /shampoo/i, /conditioner/i, /dandruff/i, /hair ?loss/i, /beard/i,
      /شعر/, /فروة/, /شامبو/, /بلسم/, /قشرة/,
    ],
  },
  {
    category: 'vitamins',
    patterns: [
      /vitamin/i, /supplement/i, /wellness/i, /mineral/i, /omega/i, /probiotic/i, /collagen/i,
      /immune/i, /multivit/i, /tablet/i, /capsule/i, /sachet/i,
      /فيتامين/, /مكمل/, /كولاجين/, /كبسول/,
    ],
  },
];

/**
 * Resolves a product's questionnaire category, falling back to `general`
 * rather than null.
 *
 * This deliberately no longer returns null. The original rule ("no match →
 * ask a human", spec §3.3) assumed an unmatched product was a taxonomy
 * oversight a human could fix. In a real pharmacy catalogue it usually isn't:
 * a lip pencil or a box of antibiotics will never become Face Care no matter
 * who looks at it, so those products just accumulated in the review queue
 * permanently. Falling back to `general` gets them described, searchable and
 * recommendable instead of stranded — see `labelingSystemPrompt('general')`
 * for the deliberately conservative instructions that category runs under.
 */
export function resolveProductCategory(input: {
  categories?: string[];
  tags?: string[];
  name?: string;
}): ProductCategory {
  const haystacks = [
    ...(input.categories ?? []),
    ...(input.tags ?? []),
    input.name ?? '',
  ].filter(Boolean);

  // Category and tag names carry more signal than the product title, so score
  // taxonomy hits first and only fall back to the title.
  for (const source of [input.categories ?? [], input.tags ?? [], [input.name ?? '']]) {
    for (const rule of RULES) {
      for (const text of source) {
        if (rule.patterns.some((p) => p.test(text))) return rule.category;
      }
    }
  }
  void haystacks;
  return 'general';
}

/**
 * Whether a product matched a real consultative shelf, as opposed to landing
 * in `general` by default. Kept separate from `resolveProductCategory()` so
 * callers that care about the distinction (admin reporting, deciding whether
 * a category is worth promoting to its own questionnaire) can ask for it
 * without reintroducing a nullable return everywhere.
 */
export function matchedSpecificShelf(input: {
  categories?: string[];
  tags?: string[];
  name?: string;
}): boolean {
  return resolveProductCategory(input) !== 'general';
}

/**
 * WooCommerce category/tag names that mean "this is a medicine", not general
 * merchandise. Deliberately a plain, readable list the store owner can extend
 * with their own real taxonomy names — the same principle as RULES above.
 */
const MEDICINE_TAXONOMY: RegExp[] = [
  /\bmedicines?\b/i, /\bmedication\b/i, /\bpharmaceutical/i, /\bprescription/i,
  /\bantibiotic/i, /\banalgesic/i, /\bpharmacy only\b/i, /\bpom\b/i, /\brx\b/i,
  /\botc\b/i, /\bover[- ]the[- ]counter\b/i,
  /دواء/, /أدوية/, /وصفة طبية/, /مضاد حيوي/,
];

/** A strength printed in the product name — "500mg", "1 g", "125 mcg", "10 IU". */
const STRENGTH_PATTERN = /\b\d+(?:\.\d+)?\s?(?:mg|mcg|µg|g|iu)\b/i;

/** A dosage form that belongs to medicine rather than cosmetics. */
const DOSAGE_FORM_PATTERN =
  /\b(?:tabs?|tablets?|caps?|capsules?|syrup|suspension|injection|ampoule|amp|suppositor\w*|inhaler|nebuli\w*|sachets?|drops?)\b/i;

/**
 * Whether a product looks like an actual medicine.
 *
 * Used to keep medicines out of the *recommendation* engine while leaving
 * them fully searchable and purchasable by name. This is not a safety
 * preference bolted on after the fact — the labeling schema deliberately
 * never collects indication, dosage, contraindication or interaction data
 * (see the vitamins and general notes in `prompts.ts`), so any ranked
 * "recommendation" of a medicine would be assembled entirely from fields
 * that are null by design. It could not be accurate even in principle.
 *
 * Only meaningful for `general` products: a strength + dosage form in the
 * name also describes "Vitamin C 500mg Tablets", which belongs on the
 * vitamins shelf and stays recommendable there. Callers scope it
 * accordingly.
 */
export function isLikelyMedicine(input: {
  categories?: string[];
  tags?: string[];
  name?: string;
}): boolean {
  const taxonomy = [...(input.categories ?? []), ...(input.tags ?? [])];
  if (taxonomy.some((t) => MEDICINE_TAXONOMY.some((p) => p.test(t)))) return true;

  const name = input.name ?? '';
  return STRENGTH_PATTERN.test(name) && DOSAGE_FORM_PATTERN.test(name);
}

/** Human-facing labels used in prompts and admin screens. */
export const CATEGORY_LABELS: Record<ProductCategory, { en: string; ar: string }> = {
  face: { en: 'Face Care', ar: 'العناية بالوجه' },
  body: { en: 'Body Care', ar: 'العناية بالجسم' },
  hair: { en: 'Hair & Scalp', ar: 'الشعر وفروة الرأس' },
  vitamins: { en: 'Vitamins & Wellness', ar: 'الفيتامينات والصحة' },
  general: { en: 'Other Products', ar: 'منتجات أخرى' },
};

export function isProductCategory(key: CategoryKey | string): key is ProductCategory {
  return (
    key === 'face' || key === 'body' || key === 'hair' || key === 'vitamins' || key === 'general'
  );
}
