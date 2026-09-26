/**
 * The two analyzer kinds.
 *
 * Both are the same machine with different vocabulary: a photo step, then the
 * questionnaire that already exists for that shelf, then the ordinary
 * recommendation engine. Nothing here duplicates scoring or eligibility —
 * an analyzer is just another way to fill in a `CustomerProfile`.
 */
import type { ProductCategory } from '../products/category.js';
import type { QuestionnaireId } from '../questionnaire/loader.js';

export type AnalyzerKind = 'skin' | 'hair';

export interface AnalyzerDefinition {
  kind: AnalyzerKind;
  /** Which shelf its recommendations come from. */
  category: ProductCategory;
  /** Which existing questionnaire drives its steps. */
  questionnaire: QuestionnaireId;
  /**
   * The only answer keys a photo is allowed to pre-fill. Anything the model
   * returns outside this list is dropped — a photo may suggest what someone's
   * skin looks like, but it must never quietly set their budget or decide
   * what they already have in their bathroom cabinet.
   */
  prefillable: string[];
  /** What the customer is asked to photograph, for the prompt and the UI. */
  subject: { en: string; ar: string };
}

export const ANALYZERS: Record<AnalyzerKind, AnalyzerDefinition> = {
  skin: {
    kind: 'skin',
    category: 'face',
    questionnaire: 'face',
    prefillable: ['skin_type', 'concern_primary', 'concern_secondary', 'sensitivity_level'],
    subject: { en: 'your face', ar: 'وجهك' },
  },
  hair: {
    kind: 'hair',
    category: 'hair',
    questionnaire: 'hair',
    prefillable: ['scalp_type', 'hair_pattern', 'hair_thickness', 'concern_primary'],
    subject: { en: 'your hair and scalp', ar: 'شعرك وفروة رأسك' },
  },
};

export function isAnalyzerKind(value: unknown): value is AnalyzerKind {
  return value === 'skin' || value === 'hair';
}
