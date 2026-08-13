/**
 * Turns raw questionnaire answers into the normalized profile the eligibility
 * filter and the scorer both read. Keeping this mapping in one place means the
 * scoring weights never have to know about question keys.
 */
import type { AnswerMap } from '../types.js';
import type { ProductCategory } from '../products/category.js';

export type BudgetBand = 'low' | 'mid' | 'high' | 'any';
export type SensitivityLevel = 'very' | 'somewhat' | 'not' | 'unknown';

export interface CustomerProfile {
  category: ProductCategory;
  product_type: string | null;
  /** skin type, scalp type, hair pattern/thickness — whatever the category asked. */
  types: string[];
  concern_primary: string | null;
  concern_secondary: string | null;
  sensitivity: SensitivityLevel;
  texture_preference: string | null;
  fragrance_preference: 'fragrance_free' | 'light' | 'love_scent' | null;
  avoid: string[];
  current_actives: string[];
  budget: BudgetBand;
  priority: string | null;
  who_for: string | null;
  area_of_use: string | null;
  /** Set when the customer said the product is for a child. */
  for_child: boolean;
}

function asArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => x && x !== 'none' && x !== 'not_sure');
}

function asString(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  const s = Array.isArray(v) ? v[0] : v;
  if (!s || s === 'not_sure' || s === 'no_preference' || s === 'none') return null;
  return s;
}

export function buildProfile(category: ProductCategory, answers: AnswerMap): CustomerProfile {
  const types: string[] = [];
  for (const key of ['skin_type', 'scalp_type', 'hair_pattern', 'hair_thickness', 'chemical_history']) {
    const v = asString(answers[key]);
    if (v) types.push(v);
  }

  const sensitivityRaw = asString(answers.sensitivity_level);
  const sensitivity: SensitivityLevel =
    sensitivityRaw === 'very' || sensitivityRaw === 'somewhat' || sensitivityRaw === 'not'
      ? sensitivityRaw
      : 'unknown';

  const avoid = new Set(asArray(answers.avoid_ingredients));
  for (const pref of asArray(answers.formula_preference)) avoid.add(pref);
  if (asString(answers.fragrance_preference) === 'fragrance_free') avoid.add('fragrance');

  const fragranceRaw = asString(answers.fragrance_preference);

  return {
    category,
    product_type: asString(answers.product_type),
    types,
    concern_primary: asString(answers.concern_primary) ?? asString(answers.goal),
    concern_secondary: asString(answers.concern_secondary),
    sensitivity,
    texture_preference: asString(answers.texture_preference) ?? asString(answers.preferred_form),
    fragrance_preference:
      fragranceRaw === 'fragrance_free' || fragranceRaw === 'light' || fragranceRaw === 'love_scent'
        ? fragranceRaw
        : null,
    avoid: [...avoid],
    current_actives: asArray(answers.current_actives),
    budget: (asString(answers.budget) as BudgetBand) ?? 'any',
    priority: asString(answers.priority),
    who_for: asString(answers.who_for),
    area_of_use: asString(answers.area_of_use),
    for_child: asString(answers.who_for) === 'child' || asString(answers.who_for_detail) === 'child',
  };
}
