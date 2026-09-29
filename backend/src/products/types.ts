/**
 * The product-type vocabulary: what a product physically IS (a shampoo, a
 * serum, a tablet), as opposed to which shelf it sits on or what it is for.
 *
 * This is the field that makes recommendations exact. A customer who asks
 * for "a shampoo for dry skin" is asking for a shampoo first — anything that
 * is not a shampoo is wrong no matter how well it matches "dry". Before this
 * existed, product type lived only in free text (names, descriptions) and
 * nothing enforced it, so a tablet whose text mentioned "dry skin" could
 * outrank every real shampoo.
 *
 * It is a closed list on purpose. The labelling model must pick one of these
 * keys (strict JSON-schema enum), the chat model must request from the same
 * keys, and the admin fixes a wrong one from a dropdown — so a type can never
 * drift into a spelling nobody filters on.
 */
import type { ProductCategory } from './category.js';

/** Where on (or in) the body the product is used. */
export type ProductApplication = 'hair_scalp' | 'face' | 'body' | 'oral_ingested' | 'other';

export const APPLICATIONS: ProductApplication[] = ['hair_scalp', 'face', 'body', 'oral_ingested', 'other'];

interface TypeDef {
  en: string;
  ar: string;
  /** The shelf a product of this type belongs on, whatever category it was filed under. */
  shelf: ProductCategory;
  /** Fixed for most types; null where it genuinely varies (a medicine can be a cream or a tablet). */
  application: ProductApplication | null;
}

export const PRODUCT_TYPES = {
  // --- Hair & scalp ---------------------------------------------------------
  shampoo: { en: 'Shampoo', ar: 'شامبو', shelf: 'hair', application: 'hair_scalp' },
  conditioner: { en: 'Conditioner', ar: 'بلسم', shelf: 'hair', application: 'hair_scalp' },
  hair_mask: { en: 'Hair mask', ar: 'ماسك الشعر', shelf: 'hair', application: 'hair_scalp' },
  hair_oil: { en: 'Hair oil', ar: 'زيت الشعر', shelf: 'hair', application: 'hair_scalp' },
  leave_in: { en: 'Leave-in conditioner / cream', ar: 'كريم شعر بدون شطف', shelf: 'hair', application: 'hair_scalp' },
  hair_serum: { en: 'Hair serum', ar: 'سيروم الشعر', shelf: 'hair', application: 'hair_scalp' },
  scalp_treatment: { en: 'Scalp treatment', ar: 'علاج فروة الرأس', shelf: 'hair', application: 'hair_scalp' },
  hair_loss_treatment: { en: 'Hair-loss treatment (topical)', ar: 'علاج تساقط الشعر (موضعي)', shelf: 'hair', application: 'hair_scalp' },
  styling: { en: 'Styling product', ar: 'منتج تصفيف', shelf: 'hair', application: 'hair_scalp' },
  hair_colour: { en: 'Hair colour', ar: 'صبغة شعر', shelf: 'hair', application: 'hair_scalp' },

  // --- Face -----------------------------------------------------------------
  cleanser: { en: 'Face cleanser', ar: 'غسول الوجه', shelf: 'face', application: 'face' },
  makeup_remover: { en: 'Makeup remover / micellar water', ar: 'مزيل مكياج', shelf: 'face', application: 'face' },
  toner: { en: 'Toner / essence', ar: 'تونر', shelf: 'face', application: 'face' },
  serum: { en: 'Face serum', ar: 'سيروم الوجه', shelf: 'face', application: 'face' },
  moisturizer: { en: 'Face moisturizer', ar: 'مرطب الوجه', shelf: 'face', application: 'face' },
  sunscreen: { en: 'Face sunscreen', ar: 'واقي شمس للوجه', shelf: 'face', application: 'face' },
  eye_care: { en: 'Eye cream / eye care', ar: 'كريم العين', shelf: 'face', application: 'face' },
  face_mask: { en: 'Face mask', ar: 'ماسك الوجه', shelf: 'face', application: 'face' },
  exfoliant: { en: 'Exfoliant / peel / scrub', ar: 'مقشر', shelf: 'face', application: 'face' },
  spot_treatment: { en: 'Spot / acne treatment', ar: 'علاج الحبوب الموضعي', shelf: 'face', application: 'face' },
  lip_care: { en: 'Lip care', ar: 'العناية بالشفاه', shelf: 'face', application: 'face' },

  // --- Body -----------------------------------------------------------------
  body_wash: { en: 'Body wash / shower gel / soap', ar: 'غسول الجسم', shelf: 'body', application: 'body' },
  body_lotion: { en: 'Body lotion / cream', ar: 'لوشن / كريم الجسم', shelf: 'body', application: 'body' },
  body_oil: { en: 'Body oil', ar: 'زيت الجسم', shelf: 'body', application: 'body' },
  body_scrub: { en: 'Body scrub', ar: 'مقشر الجسم', shelf: 'body', application: 'body' },
  deodorant: { en: 'Deodorant / antiperspirant', ar: 'مزيل العرق', shelf: 'body', application: 'body' },
  hand_care: { en: 'Hand cream / hand care', ar: 'كريم اليدين', shelf: 'body', application: 'body' },
  foot_care: { en: 'Foot care', ar: 'العناية بالقدمين', shelf: 'body', application: 'body' },
  body_sunscreen: { en: 'Body sunscreen', ar: 'واقي شمس للجسم', shelf: 'body', application: 'body' },
  intimate_care: { en: 'Intimate care', ar: 'العناية بالمنطقة الحساسة', shelf: 'body', application: 'body' },
  body_treatment: { en: 'Body treatment (stretch marks, scars, itching)', ar: 'علاج موضعي للجسم', shelf: 'body', application: 'body' },

  // --- Supplements (swallowed) ----------------------------------------------
  supplement_tablet: { en: 'Supplement — tablets', ar: 'مكمل غذائي — أقراص', shelf: 'vitamins', application: 'oral_ingested' },
  supplement_capsule: { en: 'Supplement — capsules', ar: 'مكمل غذائي — كبسولات', shelf: 'vitamins', application: 'oral_ingested' },
  supplement_gummy: { en: 'Supplement — gummies', ar: 'مكمل غذائي — حلوى', shelf: 'vitamins', application: 'oral_ingested' },
  supplement_powder: { en: 'Supplement — powder / sachets', ar: 'مكمل غذائي — بودرة', shelf: 'vitamins', application: 'oral_ingested' },
  supplement_liquid: { en: 'Supplement — liquid / syrup / drops', ar: 'مكمل غذائي — سائل', shelf: 'vitamins', application: 'oral_ingested' },
  supplement_effervescent: { en: 'Supplement — effervescent', ar: 'مكمل غذائي — فوار', shelf: 'vitamins', application: 'oral_ingested' },

  // --- Everything else a pharmacy stocks --------------------------------------
  medicine: { en: 'Medicine', ar: 'دواء', shelf: 'general', application: null },
  makeup: { en: 'Makeup', ar: 'مكياج', shelf: 'general', application: 'face' },
  nail_care: { en: 'Nail care', ar: 'العناية بالأظافر', shelf: 'general', application: 'other' },
  fragrance: { en: 'Fragrance / perfume', ar: 'عطر', shelf: 'general', application: 'body' },
  baby_care: { en: 'Baby care', ar: 'العناية بالطفل', shelf: 'general', application: 'other' },
  oral_care: { en: 'Oral & dental care', ar: 'العناية بالفم والأسنان', shelf: 'general', application: 'other' },
  first_aid: { en: 'First aid / wound care', ar: 'الإسعافات الأولية', shelf: 'general', application: 'other' },
  medical_device: { en: 'Medical device / test', ar: 'جهاز طبي', shelf: 'general', application: 'other' },
  sexual_wellness: { en: 'Sexual wellness', ar: 'الصحة الجنسية', shelf: 'general', application: 'other' },
  accessory: { en: 'Accessory / tool', ar: 'إكسسوار / أداة', shelf: 'general', application: 'other' },
  gift_set: { en: 'Gift set / bundle', ar: 'مجموعة هدايا', shelf: 'general', application: null },
  other: { en: 'Other', ar: 'أخرى', shelf: 'general', application: null },
} as const satisfies Record<string, TypeDef>;

export type ProductType = keyof typeof PRODUCT_TYPES;

export const PRODUCT_TYPE_KEYS = Object.keys(PRODUCT_TYPES) as ProductType[];

export function isProductType(value: unknown): value is ProductType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PRODUCT_TYPES, value);
}

export function isApplication(value: unknown): value is ProductApplication {
  return typeof value === 'string' && (APPLICATIONS as string[]).includes(value);
}

export function typeShelf(type: ProductType): ProductCategory {
  return PRODUCT_TYPES[type].shelf;
}

export function typeLabel(type: ProductType, language: 'en' | 'ar' = 'en'): string {
  return PRODUCT_TYPES[type][language];
}

/** The application a type implies, or null where it has to come from the product itself. */
export function typeApplication(type: ProductType): ProductApplication | null {
  return PRODUCT_TYPES[type].application;
}

export function isIngestedType(type: ProductType | null): boolean {
  return type !== null && PRODUCT_TYPES[type].application === 'oral_ingested';
}

/** One line per type, for prompts that must choose from the list. */
export function typeGlossary(): string {
  return PRODUCT_TYPE_KEYS.map((k) => `${k}: ${PRODUCT_TYPES[k].en}`).join('\n');
}

/**
 * The questionnaire's own product-type answers (face.json, hair.json …) are
 * coarser than this vocabulary — "Conditioner / mask" is one button. Each
 * answer maps to the set of types that genuinely satisfy it. An answer that
 * is not here (or "not_sure") imposes no type filter at all.
 */
const QUESTIONNAIRE_TYPE_MAP: Record<string, Record<string, ProductType[]>> = {
  face: {
    cleanser: ['cleanser', 'makeup_remover'],
    moisturizer: ['moisturizer'],
    serum: ['serum', 'spot_treatment'],
    sunscreen: ['sunscreen'],
    eye_care: ['eye_care'],
    mask: ['face_mask', 'exfoliant'],
  },
  hair: {
    shampoo: ['shampoo'],
    conditioner: ['conditioner', 'hair_mask', 'leave_in'],
    scalp_treatment: ['scalp_treatment', 'hair_serum', 'hair_oil'],
    hair_loss: ['hair_loss_treatment', 'scalp_treatment', 'hair_serum', 'shampoo'],
    styling: ['styling', 'hair_oil', 'hair_serum', 'leave_in'],
  },
  body: {
    wash: ['body_wash'],
    moisturizer: ['body_lotion', 'body_oil'],
    deodorant: ['deodorant'],
    hand_foot: ['hand_care', 'foot_care'],
    treatment: ['body_treatment', 'body_scrub', 'intimate_care'],
  },
  general: {
    makeup: ['makeup', 'nail_care', 'makeup_remover'],
    baby: ['baby_care'],
    oral: ['oral_care'],
    first_aid: ['first_aid', 'medical_device'],
    fragrance: ['fragrance'],
  },
};

/** Vitamins ask for a *form* rather than a product type. */
const VITAMIN_FORM_MAP: Record<string, ProductType[]> = {
  tablet: ['supplement_tablet', 'supplement_effervescent'],
  capsule: ['supplement_capsule'],
  gummy: ['supplement_gummy'],
  powder: ['supplement_powder'],
  liquid: ['supplement_liquid'],
};

export function typesForQuestionnaireAnswer(
  shelf: ProductCategory,
  answers: { product_type?: string | null; preferred_form?: string | null },
): ProductType[] {
  if (shelf === 'vitamins') {
    const form = answers.preferred_form ?? '';
    return VITAMIN_FORM_MAP[form] ?? [];
  }
  const value = answers.product_type ?? '';
  return QUESTIONNAIRE_TYPE_MAP[shelf]?.[value] ?? [];
}
