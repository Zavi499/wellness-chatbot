/**
 * Auto-labeling prompt templates (spec §13), one per category.
 *
 * The invariant across all of them: the model may only restate what the source
 * text supports. Nulls are the correct answer for anything it cannot see.
 */
import type { ProductCategory } from '../products/category.js';
import { CATEGORY_LABELS } from '../products/category.js';
import { typeGlossary } from '../products/types.js';

const SHARED_SYSTEM = `You are labeling a product for a pharmacy and wellness
e-commerce catalogue in Kuwait. You are given six things from the store's own
data: the product NAME, its store CATEGORIES, its store TAGS, its DESCRIPTION,
its INGREDIENTS and its HOW TO USE. Using ONLY those, output a JSON object
matching the given schema. Customers are recommended products from these
labels, so a wrong label means a wrong product in front of a customer.

PRODUCT TYPE — the most important field. Choose what the product physically
IS from this fixed list:
${typeGlossary()}

Decide it from the NAME first, then HOW TO USE, then CATEGORIES, then the
DESCRIPTION.
- Choose the functional type, not the audience: a baby shampoo is "shampoo",
  a men's face wash is "cleanser", a kids' toothpaste is "oral_care".
- Anything swallowed — tablets, capsules, softgels, gummies, sachets, syrups,
  drinkable ampoules, drops taken by mouth — is a supplement_* type or
  "medicine". Never a skin, hair or body type, even when it is "for hair",
  "for skin" or "for nails".
- A medicine (antibiotic, painkiller, prescription or pharmacy-only drug,
  anything with an active pharmaceutical ingredient and a strength) is
  "medicine" whatever its form, including medicated creams and drops.
- A set of several different products sold together is "gift_set".
- Use "other" only when nothing on the list fits.
Set "application" to where it is used; for anything swallowed it is
"oral_ingested".

EVIDENCE
- Concerns and suitable types must come from what the six fields say, not
  from what products of this type usually do. A shampoo whose text never
  mentions dryness is not labelled for dryness.
- When INGREDIENTS is given it is authoritative: take key_ingredients from it
  (the headline actives, exact spelling) and judge fragrance and alcohol from
  it.
- When HOW TO USE is given, how_to_use must restate it faithfully in at most
  two sentences — do not add steps it does not contain.
- Categories and tags are the store's own filing: strong hints about type and
  use, but a product can be misfiled — the name wins over a category.

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
  /** Full paths where known ("Hair Care > Shampoo"); each is a separate category. */
  categoryPaths: string[];
  tags: string[];
  description: string | null;
  shortDescription: string | null;
  ingredientsRaw: string | null;
  howToUse: string | null;
  brand: string | null;
  /** Set when the admin's category map fixes this product's type. */
  fixedType?: string | null;
  /** A real, human WPML translation — not previously AI-generated output. */
  existingNameAr?: string | null;
  existingDescriptionAr?: string | null;
}

/** Long HTML-heavy descriptions add cost without adding facts past this point. */
const MAX_FIELD_CHARS = 6000;

function clip(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.trim();
  if (t === '') return null;
  return t.length > MAX_FIELD_CHARS ? `${t.slice(0, MAX_FIELD_CHARS)} …` : t;
}

export function labelingUserPrompt(input: LabelingInput): string {
  const label = CATEGORY_LABELS[input.category].en;
  const lines = [
    `NAME: ${input.name}`,
    `BRAND: ${input.brand ?? '(not specified)'}`,
    `STORE CATEGORIES (each line is a separate category the product is filed in):`,
    ...(input.categoryPaths.length ? input.categoryPaths.map((c) => `  - ${c}`) : ['  (none)']),
    `STORE TAGS: ${input.tags.length ? input.tags.join(', ') : '(none)'}`,
    `SHORT DESCRIPTION: ${clip(input.shortDescription) ?? '(none)'}`,
    `DESCRIPTION: ${clip(input.description) ?? '(none)'}`,
    `INGREDIENTS (store's own field): ${clip(input.ingredientsRaw) ?? '(not provided)'}`,
    `HOW TO USE (store's own field): ${clip(input.howToUse) ?? '(not provided)'}`,
    '',
    `Shelf this product is being labelled for: ${label}.`,
  ];
  if (input.fixedType) {
    lines.push(
      `The store has confirmed every product in this category is of type "${input.fixedType}". Use that product_type unless the NAME clearly says otherwise.`,
    );
  }
  if (input.existingNameAr || input.existingDescriptionAr) {
    lines.push(
      '',
      'This product already has a human (not machine) Arabic translation — reuse its exact terminology and phrasing for any Arabic output rather than translating the English text yourself:',
      `Existing Arabic name: ${input.existingNameAr ?? '(none)'}`,
      `Existing Arabic description: ${clip(input.existingDescriptionAr) ?? '(none)'}`,
    );
  }
  return lines.join('\n');
}
