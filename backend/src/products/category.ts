/**
 * Maps a WooCommerce category/tag set onto the four questionnaire categories
 * (spec §4.4). Store taxonomies drift, so this is a keyword mapping the store
 * owner can extend, not a hardcoded taxonomy ID list.
 */
import type { CategoryKey } from '../types.js';

/** The four sellable categories; `routine` and `compare` are flows, not shelves. */
export type ProductCategory = 'face' | 'body' | 'hair' | 'vitamins';

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
 * Resolves a product's questionnaire category. Returns null when nothing
 * matches — the labeling pipeline treats that as "ask a human", it does not
 * guess a category (spec §3.3).
 */
export function resolveProductCategory(input: {
  categories?: string[];
  tags?: string[];
  name?: string;
}): ProductCategory | null {
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
  return null;
}

/** Human-facing labels used in prompts and admin screens. */
export const CATEGORY_LABELS: Record<ProductCategory, { en: string; ar: string }> = {
  face: { en: 'Face Care', ar: 'العناية بالوجه' },
  body: { en: 'Body Care', ar: 'العناية بالجسم' },
  hair: { en: 'Hair & Scalp', ar: 'الشعر وفروة الرأس' },
  vitamins: { en: 'Vitamins & Wellness', ar: 'الفيتامينات والصحة' },
};

export function isProductCategory(key: CategoryKey | string): key is ProductCategory {
  return key === 'face' || key === 'body' || key === 'hair' || key === 'vitamins';
}
