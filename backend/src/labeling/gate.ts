/**
 * The pharmacist-review hard gate (spec §3.3 step 4).
 *
 * Deliberately a pure function with no I/O so it can be unit-tested and reused
 * by both the labeling pipeline and the admin approval path. This is a schema-
 * level rule, not a prompt preference: if it returns true, no ordinary admin
 * can mark the product `verified`.
 */
import type { ProductCategory } from '../products/category.js';

/**
 * Words that put a product in pharmacist territory. Kept explicit rather than
 * clever — a reviewer must be able to read and extend this list.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  // Pregnancy / breastfeeding
  /\bpregnan\w*/i, /\bbreastfeed\w*/i, /\bnursing\b/i, /\blactat\w*/i, /\bpostpartum\b/i,
  /حامل/, /الحمل/, /مرضع/, /الرضاعة/,
  // Infants / children
  /\binfant\w*/i, /\bnewborn\b/i, /\bbaby\b/i, /\bbabies\b/i, /\btoddler\w*/i,
  /\bchild(?:ren)?\b/i, /\bpaediatric\b/i, /\bpediatric\b/i, /\bunder \d+ (?:year|month)/i,
  /رضيع/, /الأطفال/, /طفل/, /مواليد/,
  // Medicines / interactions
  /\bmedicin\w*/i, /\bmedication\w*/i, /\bprescription\b/i, /\bdrug interaction\w*/i,
  /\binteract\w* with\b/i, /\bcontraindicat\w*/i, /\banticoagulant\w*/i, /\bblood thinner\w*/i,
  /\bconsult (?:your|a) (?:doctor|physician|pharmacist)\b/i,
  /دواء/, /أدوية/, /وصفة طبية/, /تداخل دوائي/, /استشر الطبيب/,
];

export interface GateInput {
  category: ProductCategory | null;
  /** Any text worth scanning: name, description, and the AI draft serialized. */
  text: string;
  /** Explicit signal the labeling model was asked to raise. */
  modelFlaggedSensitive?: boolean;
}

export interface GateResult {
  requiresPharmacistReview: boolean;
  reasons: string[];
}

export function evaluatePharmacistGate(input: GateInput): GateResult {
  const reasons: string[] = [];

  // Category-based hard gate: the whole Vitamins & Wellness shelf.
  if (input.category === 'vitamins') {
    reasons.push('Category is Vitamins & Wellness');
  }

  if (input.modelFlaggedSensitive) {
    reasons.push('Labeling model flagged a sensitive topic');
  }

  for (const pattern of SENSITIVE_PATTERNS) {
    const match = input.text.match(pattern);
    if (match) {
      reasons.push(`Text mentions "${match[0]}"`);
      break; // One citation is enough; the reviewer reads the product anyway.
    }
  }

  return { requiresPharmacistReview: reasons.length > 0, reasons };
}
