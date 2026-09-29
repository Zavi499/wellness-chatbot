/**
 * Deterministic checks on a labelled product type.
 *
 * The labelling model is good but not infallible, and a wrong product type is
 * the one mistake customers notice instantly (a tablet offered as a
 * shampoo). These rules compare the type against the product's own NAME —
 * the strongest, least ambiguous evidence there is — and report a
 * contradiction instead of silently trusting either side. A product with an
 * issue is held back from recommendations until an admin confirms its type
 * (see `label_issues` and the Accuracy screen).
 *
 * Name only, on purpose: descriptions routinely mention other products
 * ("use after our shampoo"), so checking them would flag half the catalogue.
 */
import type { ProductType } from '../products/types.js';

const SUPPLEMENTS: ProductType[] = [
  'supplement_tablet',
  'supplement_capsule',
  'supplement_gummy',
  'supplement_powder',
  'supplement_liquid',
  'supplement_effervescent',
];

interface NameRule {
  /** Human-readable, shown to the admin. */
  word: string;
  pattern: RegExp;
  allowed: ProductType[];
}

const NAME_RULES: NameRule[] = [
  {
    word: 'shampoo',
    pattern: /\bshampoo|شامبو/i,
    allowed: ['shampoo', 'scalp_treatment', 'hair_loss_treatment', 'gift_set'],
  },
  {
    word: 'conditioner',
    pattern: /\bconditioner|بلسم/i,
    // A "2-in-1 shampoo & conditioner" is a shampoo.
    allowed: ['conditioner', 'leave_in', 'hair_mask', 'shampoo', 'gift_set'],
  },
  {
    word: 'deodorant',
    pattern: /\bdeodorant|\banti-?perspirant|مزيل (?:ال)?عرق/i,
    allowed: ['deodorant', 'gift_set'],
  },
  {
    word: 'tablets / capsules',
    pattern: /\b(?:tablets?|tabs|capsules?|caps|softgels?|gumm(?:y|ies)|effervescent)\b|أقراص|كبسول/i,
    allowed: [...SUPPLEMENTS, 'medicine', 'gift_set'],
  },
  {
    word: 'sunscreen / SPF',
    pattern: /\bsunscreen|\bsun ?block|\bspf ?\d+|واقي (?:ال)?شمس/i,
    allowed: ['sunscreen', 'body_sunscreen', 'moisturizer', 'makeup', 'lip_care', 'gift_set'],
  },
  {
    word: 'face wash / cleanser',
    pattern: /\bface ?wash|\bfacial cleanser|غسول (?:ال)?وجه/i,
    allowed: ['cleanser', 'makeup_remover', 'gift_set'],
  },
  {
    word: 'toothpaste / mouthwash',
    pattern: /\btooth ?paste|\bmouth ?wash|\btooth ?brush|معجون (?:ال)?أسنان/i,
    allowed: ['oral_care', 'gift_set'],
  },
];

/**
 * Returns a readable description of each contradiction between the product's
 * name and its assigned type. Empty means consistent (or nothing to check).
 */
export function productTypeIssues(name: string, type: ProductType | null): string[] {
  if (!type) return ['No product type was assigned.'];
  const issues: string[] = [];
  for (const rule of NAME_RULES) {
    if (rule.pattern.test(name) && !rule.allowed.includes(type)) {
      issues.push(`The name mentions "${rule.word}" but the product type is "${type}".`);
    }
  }
  return issues;
}
