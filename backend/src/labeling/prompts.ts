/**
 * Auto-labeling prompt templates (spec §13), one per category.
 *
 * The invariant across all of them: the model may only restate what the source
 * text supports. Nulls are the correct answer for anything it cannot see.
 */
import type { ProductCategory } from '../products/category.js';
import { CATEGORY_LABELS } from '../products/category.js';

const SHARED_SYSTEM = `You are labeling a product for a wellness e-commerce
catalogue in Kuwait. Using ONLY the product name, description, and attributes
provided, output a JSON object matching the given schema.

Hard rules:
- If a field cannot be determined from the provided text, output null (or an
  empty array) for it rather than guessing.
- Do not invent ingredient names, claims, suitability, warnings, or age limits
  that are not supported by the source text.
- Do not use absolute claims such as "cures", "guarantees", "eliminates".
  Use supportive language such as "helps support" or "may improve the
  appearance of".
- Arabic output must read naturally, not machine-translated. Keep brand names
  and product names exactly as listed in the catalogue, in Latin script, even
  inside Arabic text.
- Include a "confidence" field from 0 to 1 reflecting how well-supported your
  overall output is by the source text. Be honest and conservative: a thin
  one-line description should score low.
- Set "mentions_sensitive_topic" to true if anything in the source text or in
  your own output touches pregnancy, breastfeeding, infants, children, or
  medicines and their interactions.`;

const CATEGORY_NOTES: Record<ProductCategory, string> = {
  face: `This is a Face Care product. Pay attention to skin type suitability,
actives (retinoids, acids, vitamin C), texture and finish, and whether it is a
daytime or nighttime step. If it is a sunscreen, capture the finish, whether it
is tinted, and water resistance in texture_finish when the text states them.`,

  body: `This is a Body Care product. Pay attention to area of use, fragrance,
and texture. If the product is for an intimate area or is described for broken,
infected or severely irritated skin, keep suitability fields conservative and
set mentions_sensitive_topic to true.`,

  hair: `This is a Hair & Scalp product. Pay attention to scalp type, hair
pattern and thickness, chemical treatment compatibility, and wash frequency. If
the product makes hair-loss claims, record the claim only as written and do not
extend it into a medical claim.`,

  vitamins: `This is a Vitamins & Wellness product. ADDITIONAL HARD RULE: do not
infer dosage safety, upper limits, drug interactions, or suitability for
pregnancy, breastfeeding, children or chronic conditions. Leave those fields
null for a pharmacist to complete rather than modelling a guess. Copy serving
size and key amounts EXACTLY as printed in the source text, or null if they are
not printed. Always set mentions_sensitive_topic to true for this category.`,

  general: `This product did not match any of the four consultative shelves —
it is something else the pharmacy stocks: makeup, baby care, oral care, first
aid, a device, an accessory, a household item, or a medicine.

Describe it plainly and factually from the source text. Do not force it into
skincare language: "concern" here means whatever need the product serves, not
a skin condition.

ADDITIONAL HARD RULE — medicines. If this is a medicine (an antibiotic, a
painkiller, anything prescription-only, anything with an active
pharmaceutical ingredient and a strength like "500mg" or "1g" in its name),
then: set mentions_sensitive_topic to true, and leave concern_primary,
concern_secondary and suitable_types EMPTY. Do not describe what condition it
treats, who should take it, or when to use it, even if the source text says
so. A medicine may be listed and found by name, but nothing here may become
the basis of a recommendation to take it — that requires a pharmacist, not a
catalogue. Record only what is on the box: name, form, strength, and any
warnings printed in the source.`,
};

export function labelingSystemPrompt(category: ProductCategory): string {
  return `${SHARED_SYSTEM}\n\n${CATEGORY_NOTES[category]}`;
}

export interface LabelingInput {
  name: string;
  category: ProductCategory;
  categoryNames: string[];
  description: string | null;
  shortDescription: string | null;
  attributes: string | null;
  ingredientsRaw: string | null;
  brand: string | null;
  /** A real, human WPML translation — not previously AI-generated output. */
  existingNameAr?: string | null;
  existingDescriptionAr?: string | null;
}

export function labelingUserPrompt(input: LabelingInput): string {
  const label = CATEGORY_LABELS[input.category].en;
  const lines = [
    `Product name: ${input.name}`,
    `Brand: ${input.brand ?? '(not specified)'}`,
    `Category: ${label} (store taxonomy: ${input.categoryNames.join(' > ') || 'n/a'})`,
    `Short description: ${input.shortDescription ?? '(none)'}`,
    `Description: ${input.description ?? '(none)'}`,
    `Attributes: ${input.attributes ?? '(none)'}`,
    `Full ingredient list (if available): ${input.ingredientsRaw ?? '(none)'}`,
  ];
  if (input.existingNameAr || input.existingDescriptionAr) {
    lines.push(
      '',
      'This product already has a human (not machine) Arabic translation — reuse its exact terminology and phrasing for any Arabic output rather than translating the English text yourself:',
      `Existing Arabic name: ${input.existingNameAr ?? '(none)'}`,
      `Existing Arabic description: ${input.existingDescriptionAr ?? '(none)'}`,
    );
  }
  return lines.join('\n');
}
