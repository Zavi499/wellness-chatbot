/**
 * JSON schemas for the auto-labeling structured-output calls (spec §13).
 *
 * One schema per category so the model is only asked for fields that make
 * sense for that shelf. Every field is nullable on purpose — "I could not
 * determine this from the source text" must be expressible, otherwise the
 * model invents a value (spec §3.3 step 2, §13).
 */
import type { ProductCategory } from '../products/category.js';

type JsonSchema = Record<string, unknown>;

const bilingualList = (description: string): JsonSchema => ({
  type: 'object',
  description,
  properties: {
    en: { type: 'array', items: { type: 'string' } },
    ar: { type: 'array', items: { type: 'string' } },
  },
  required: ['en', 'ar'],
  additionalProperties: false,
});

const bilingualText = (description: string): JsonSchema => ({
  type: 'object',
  description,
  properties: {
    en: { type: ['string', 'null'] },
    ar: { type: ['string', 'null'] },
  },
  required: ['en', 'ar'],
  additionalProperties: false,
});

/** Fields every category shares. */
function baseProperties(): Record<string, JsonSchema> {
  return {
    name_ar: {
      type: ['string', 'null'],
      description:
        'Arabic product name. Keep brand and product names exactly as listed — transliterate only the descriptive part, or return null if unsure.',
    },
    concern_primary: bilingualList('Main concerns this product addresses, e.g. acne, dryness, pigmentation.'),
    concern_secondary: bilingualList('Secondary concerns, if clearly supported by the text.'),
    suitable_types: bilingualList('Skin / scalp / hair types this suits, e.g. oily, sensitive, curly.'),
    not_ideal_for: bilingualText('Who should avoid this, or when it is a poor fit. Null if not stated.'),
    key_ingredients: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Headline active ingredients, exact names as written in the source. Do NOT translate and do NOT invent.',
    },
    texture_finish: bilingualText('Texture and finish, e.g. lightweight gel, matte finish.'),
    fragrance: {
      type: 'string',
      enum: ['yes', 'no', 'unspecified'],
      description: 'Does it contain fragrance? Use "unspecified" unless the source text says.',
    },
    fragrance_type: { type: ['string', 'null'] },
    alcohol: {
      type: 'string',
      enum: ['yes', 'no', 'unspecified'],
      description: 'Does it contain alcohol? Use "unspecified" unless the source text says.',
    },
    alcohol_type: { type: ['string', 'null'] },
    how_to_use: bilingualText('One or two sentences on how to use it.'),
    age_suitability: {
      type: 'string',
      enum: ['adult', 'teen', 'child', 'infant', 'all'],
      description: 'Only narrow this when the source text supports it; otherwise "all".',
    },
    age_min: { type: ['integer', 'null'] },
    age_max: { type: ['integer', 'null'] },
    warnings: bilingualText('Safety warnings stated in the source text. Never invent a warning.'),
    synonyms_en: {
      type: 'array',
      items: { type: 'string' },
      description: 'English words a customer might search this by, including common misspellings.',
    },
    synonyms_ar: {
      type: 'array',
      items: { type: 'string' },
      description: 'Arabic words a customer might search this by.',
    },
    pregnancy_guidance: {
      type: ['string', 'null'],
      description:
        'Leave null unless the source text explicitly gives pregnancy/breastfeeding guidance. Never infer it.',
    },
    mentions_sensitive_topic: {
      type: 'boolean',
      description:
        'True if the product name, description or your output touches pregnancy, breastfeeding, infants, children, medicines or medicine interactions.',
    },
    confidence: {
      type: 'number',
      description: 'How well-supported your overall output is by the source text, 0 to 1.',
    },
  };
}

function withRoutineStep(props: Record<string, JsonSchema>): Record<string, JsonSchema> {
  return {
    ...props,
    routine_step: {
      type: ['string', 'null'],
      description: 'e.g. cleanse, tone, treat, moisturize, protect, style, supplement.',
    },
    routine_time: { type: ['string', 'null'], enum: ['am', 'pm', 'both', null] },
  };
}

/**
 * Vitamins deliberately omit dosage/interaction fields: the spec forbids the
 * model modelling a guess there — a pharmacist fills them in (§13).
 */
function schemaFor(category: ProductCategory): JsonSchema {
  const props =
    category === 'vitamins' ? baseProperties() : withRoutineStep(baseProperties());

  if (category === 'vitamins') {
    props.serving_size = {
      type: ['string', 'null'],
      description:
        'Serving size EXACTLY as printed in the source text. Null if not printed — never calculate or estimate it.',
    };
    props.key_amounts = {
      type: ['string', 'null'],
      description:
        'Key ingredient amounts exactly as printed in the source text. Null if not printed.',
    };
    props.dietary = {
      type: 'array',
      items: { type: 'string' },
      description: 'e.g. vegan, halal, gluten-free — only if the source text says so.',
    };
    props.form = {
      type: ['string', 'null'],
      description: 'tablet, capsule, gummy, powder, liquid, sachet.',
    };
  }

  return {
    type: 'object',
    properties: props,
    required: Object.keys(props),
    additionalProperties: false,
  };
}

export const LABEL_SCHEMAS: Record<ProductCategory, JsonSchema> = {
  face: schemaFor('face'),
  body: schemaFor('body'),
  hair: schemaFor('hair'),
  vitamins: schemaFor('vitamins'),
};

/** The shape the model returns, before validation. */
export interface LabelDraft {
  name_ar?: string | null;
  concern_primary?: { en: string[]; ar: string[] };
  concern_secondary?: { en: string[]; ar: string[] };
  suitable_types?: { en: string[]; ar: string[] };
  not_ideal_for?: { en: string | null; ar: string | null };
  key_ingredients?: string[];
  texture_finish?: { en: string | null; ar: string | null };
  fragrance?: 'yes' | 'no' | 'unspecified';
  fragrance_type?: string | null;
  alcohol?: 'yes' | 'no' | 'unspecified';
  alcohol_type?: string | null;
  how_to_use?: { en: string | null; ar: string | null };
  routine_step?: string | null;
  routine_time?: 'am' | 'pm' | 'both' | null;
  age_suitability?: 'adult' | 'teen' | 'child' | 'infant' | 'all';
  age_min?: number | null;
  age_max?: number | null;
  warnings?: { en: string | null; ar: string | null };
  synonyms_en?: string[];
  synonyms_ar?: string[];
  pregnancy_guidance?: string | null;
  mentions_sensitive_topic?: boolean;
  confidence?: number;
  serving_size?: string | null;
  key_amounts?: string | null;
  dietary?: string[];
  form?: string | null;
}
