/**
 * Safety trigger rules (spec §5.1, §5.2).
 *
 * These are hard gates evaluated in code BEFORE the model is called, not
 * prompt guidance the model may skip under pressure. A pure function with no
 * I/O so the whole trigger table is unit-testable.
 *
 * Bilingual by construction: every trigger carries both English and Arabic
 * patterns, because a Kuwaiti customer in distress will not switch to English.
 */
import type { EscalationUrgency } from '../types.js';
import { normalizeArabic } from '../search/normalize.js';

export interface SafetyRule {
  id: string;
  urgency: EscalationUrgency;
  description: string;
  patterns: RegExp[];
}

/**
 * §5.1 — emergency. Selling stops for the rest of the conversation.
 */
export const EMERGENCY_RULES: SafetyRule[] = [
  {
    id: 'breathing',
    urgency: 'emergency',
    description: 'Difficulty breathing',
    patterns: [
      /\b(can'?t|cannot|difficulty|trouble|hard to|struggling to)\s+breath\w*/i,
      /\bshortness of breath\b/i,
      /\bwheez\w*/i,
      /\bchoking\b/i,
      /لا استطيع التنفس/, /صعوبه في التنفس/, /ضيق تنفس/, /ضيق في التنفس/, /اختناق/,
    ],
  },
  {
    id: 'swelling',
    urgency: 'emergency',
    description: 'Facial or tongue swelling',
    patterns: [
      /\b(face|facial|lip|lips|tongue|throat)\b[^.!?]{0,30}\bswell\w*/i,
      /\bswell\w*[^.!?]{0,30}\b(face|lip|lips|tongue|throat)\b/i,
      /\bangioedema\b/i,
      /تورم (?:في )?(?:الوجه|اللسان|الشفاه|الحلق)/, /انتفاخ (?:الوجه|اللسان)/,
    ],
  },
  {
    id: 'anaphylaxis',
    urgency: 'emergency',
    description: 'Severe allergic reaction',
    patterns: [
      /\banaphyla\w*/i,
      /\bsevere allergic reaction\b/i,
      /\ballergic reaction\b[^.!?]{0,40}\b(severe|bad|serious|emergency)\b/i,
      /حساسيه شديده/, /صدمه تحسسيه/, /رد فعل تحسسي شديد/,
    ],
  },
  {
    id: 'fainting',
    urgency: 'emergency',
    description: 'Fainting or loss of consciousness',
    patterns: [
      /\b(faint\w*|passed out|passing out|unconscious|blackout|black out)\b/i,
      /اغماء/, /فقدان الوعي/, /غاب عن الوعي/,
    ],
  },
  {
    id: 'chest_pain',
    urgency: 'emergency',
    description: 'Chest pain',
    patterns: [
      /\bchest\s+(pain|tightness|pressure)\b/i,
      /\bpain in (?:my|the) chest\b/i,
      /الم في الصدر/, /ضغط في الصدر/, /الم بالصدر/,
    ],
  },
  {
    id: 'stroke',
    urgency: 'emergency',
    description: 'Stroke symptoms',
    patterns: [
      /\bstroke\b/i,
      /\b(face|arm|leg)\b[^.!?]{0,25}\b(droop\w*|numb\w*|weak\w*)\b[^.!?]{0,25}\b(sudden\w*|one side)\b/i,
      /\bslurred speech\b/i,
      /\bsudden(?:ly)? (?:numb\w*|weak\w*) on one side\b/i,
      /جلطه/, /سكته دماغيه/, /تلعثم مفاجئ/, /خدر في جانب واحد/,
    ],
  },
  {
    id: 'bleeding',
    urgency: 'emergency',
    description: 'Severe bleeding',
    patterns: [
      /\b(severe|heavy|won'?t stop|uncontrolled)\s+bleed\w*/i,
      /\bbleeding\b[^.!?]{0,25}\b(won'?t stop|heavily|badly)\b/i,
      /نزيف شديد/, /نزيف لا يتوقف/,
    ],
  },
  {
    id: 'poisoning',
    urgency: 'emergency',
    description: 'Suspected poisoning or overdose',
    patterns: [
      /\b(poison\w*|overdose|od'?d|swallowed)\b[^.!?]{0,40}\b(pill|tablet|bottle|chemical|bleach|product)\b/i,
      /\b(overdose|poisoning)\b/i,
      /\bate .{0,20}(bleach|chemical|whole bottle)\b/i,
      /تسمم/, /جرعه زائده/, /بلع (?:الدواء|المنتج|مواد)/,
    ],
  },
  {
    id: 'eye',
    urgency: 'emergency',
    description: 'Severe eye pain or sudden vision change',
    patterns: [
      /\bsevere eye pain\b/i,
      /\b(sudden|suddenly)\b[^.!?]{0,25}\b(vision|sight)\b/i,
      /\b(lost|losing|blurred)\s+(?:my\s+)?(?:vision|sight)\b/i,
      /الم شديد في العين/, /فقدان (?:مفاجئ )?(?:للنظر|الرؤيه)/, /زغللة مفاجئه/,
    ],
  },
  {
    id: 'chemical',
    urgency: 'emergency',
    description: 'Chemical exposure or burn',
    patterns: [
      /\bchemical\s+(burn|exposure|splash)\b/i,
      /\b(bleach|acid|peroxide)\b[^.!?]{0,25}\b(in|into)\b[^.!?]{0,15}\beyes?\b/i,
      /\bburn\w*\b[^.!?]{0,20}\bskin\b[^.!?]{0,20}\b(chemical|acid|peel)\b/i,
      /حرق كيميائي/, /دخل (?:في )?العين/, /تعرض لمواد كيميائيه/,
    ],
  },
  {
    id: 'severe_rash',
    urgency: 'emergency',
    description: 'Severe blistering or peeling rash with fever',
    patterns: [
      /\b(blister\w*|peel\w*)\b[^.!?]{0,40}\bfever\b/i,
      /\bfever\b[^.!?]{0,40}\b(blister\w*|peel\w*|rash)\b[^.!?]{0,20}\b(severe|spreading|all over)\b/i,
      /\bskin (?:is )?(?:falling off|peeling off)\b/i,
      /طفح مع حراره/, /تقرحات مع حمى/, /تقشر الجلد مع حراره/,
    ],
  },
  {
    id: 'unwell_child',
    urgency: 'emergency',
    description: 'A clearly very unwell infant or child',
    patterns: [
      /\b(baby|infant|newborn|child|toddler)\b[^.!?]{0,40}\b(not breathing|limp|unresponsive|blue|convuls\w*|seizure|very high fever|won'?t wake)\b/i,
      /\b(my|the)\s+(baby|child)\b[^.!?]{0,30}\bemergency\b/i,
      /طفل\w*[^.!?]{0,30}(لا يتنفس|تشنج|حراره عاليه جدا|لا يستجيب)/,
      /رضيع\w*[^.!?]{0,30}(لا يتنفس|تشنج|لا يستجيب)/,
    ],
  },
];

/**
 * §5.2 — pharmacist review. Selling pauses on this topic; the rest of the
 * conversation may continue.
 */
export const PHARMACIST_RULES: SafetyRule[] = [
  {
    id: 'pregnancy',
    urgency: 'pharmacist_review',
    description: 'Pregnancy or breastfeeding suitability',
    patterns: [
      /\bpregnan\w*/i, /\bbreastfeed\w*/i, /\bnursing\b/i, /\bexpecting a baby\b/i,
      /\btrying to conceive\b/i, /\bpostpartum\b/i,
      /حامل/, /الحمل/, /مرضع/, /الرضاعه/, /بعد الولاده/,
    ],
  },
  {
    id: 'infant_child',
    urgency: 'pharmacist_review',
    description: 'Product for an infant or young child with unclear age suitability',
    patterns: [
      /\bfor (?:my )?(?:baby|infant|newborn|toddler)\b/i,
      /\b(\d{1,2})[- ]month[- ]old\b/i,
      /\bmy (?:son|daughter|child) is (\d{1,2})\b/i,
      /\bsafe for (?:kids|children|babies)\b/i,
      /لطفلي/, /لرضيعي/, /عمره \d+ (?:شهر|سنه|سنوات)/, /امن للاطفال/,
    ],
  },
  {
    id: 'medicine_interaction',
    urgency: 'pharmacist_review',
    description: 'Medicine interaction question',
    patterns: [
      /\binteract\w*\b[^.!?]{0,30}\b(medicine|medication|drug|pill|tablet)\b/i,
      /\b(taking|on)\b[^.!?]{0,20}\b(medication|medicine|prescription|antibiotic|blood thinner|warfarin|insulin)\b/i,
      /\bcan i take (?:this|it) with\b/i,
      /\bwith my (?:medication|medicine|pills)\b/i,
      /تداخل\w*[^.!?]{0,20}(دواء|ادويه)/, /اتناول دواء/, /مع ادويتي/, /هل يتعارض/,
    ],
  },
  {
    id: 'chronic_condition',
    urgency: 'pharmacist_review',
    description: 'Chronic condition or prescription-treatment context',
    patterns: [
      /\b(diabet\w*|thyroid|hypertension|high blood pressure|kidney disease|liver disease|epilep\w*|lupus|psoriasis|eczema flare|autoimmune|cancer|chemotherapy)\b/i,
      /\bmy (?:doctor|dermatologist) (?:prescribed|gave me|put me on)\b/i,
      /\bprescription\b/i, /\baccutane|isotretinoin|roaccutane\b/i,
      /سكري/, /ضغط الدم/, /الغده/, /الكلى/, /الكبد/, /صرع/, /علاج كيماوي/,
      /وصف لي الطبيب/, /وصفه طبيه/,
    ],
  },
  {
    id: 'persistent_symptoms',
    urgency: 'pharmacist_review',
    description: 'Persistent, severe, infected or unexplained symptoms',
    patterns: [
      /\b(infected|infection|pus|oozing|abscess)\b/i,
      /\b(rash|itch\w*|pain)\b[^.!?]{0,30}\b(weeks|months|not going away|getting worse|spreading)\b/i,
      /\bunexplained\b[^.!?]{0,20}\b(rash|bleeding|loss|lump)\b/i,
      /\bopen (?:wound|sore)\b/i, /\bbroken skin\b/i,
      /التهاب/, /صديد/, /لا يختفي/, /يزداد سوءا/, /جرح مفتوح/, /طفح غير مفسر/,
    ],
  },
  {
    id: 'diagnosis_request',
    urgency: 'pharmacist_review',
    description: 'Request for a diagnosis or a dose/treatment change',
    patterns: [
      /\bwhat(?:'s| is) wrong with (?:my|me)\b/i,
      /\bdo i have\b[^.!?]{0,30}\b(infection|condition|disease|deficiency)\b/i,
      /\bdiagnos\w*/i,
      /\bshould i (?:stop|increase|decrease|double)\b[^.!?]{0,25}\b(taking|dose|medication|treatment)\b/i,
      /\bhow (?:much|many)\b[^.!?]{0,25}\bshould i take\b/i,
      /ماذا لدي/, /هل عندي (?:نقص|التهاب|مرض)/, /تشخيص/, /اوقف الدواء/, /اغير الجرعه/,
      /كم حبه اخذ/,
    ],
  },
];

export const ALL_RULES: SafetyRule[] = [...EMERGENCY_RULES, ...PHARMACIST_RULES];

export interface TriggerMatch {
  rule_id: string;
  urgency: EscalationUrgency;
  description: string;
  matched_text: string;
}

/** Prepares text for matching: Arabic orthography folded, whitespace collapsed. */
function prepare(text: string): string {
  return normalizeArabic(text).replace(/\s+/g, ' ').trim();
}

/**
 * Evaluates a customer message. Emergency rules are checked first — if one
 * fires, that is the answer and no selling may continue.
 */
export function detectTriggers(message: string): TriggerMatch[] {
  const text = prepare(message);
  const matches: TriggerMatch[] = [];

  for (const rule of EMERGENCY_RULES) {
    for (const pattern of rule.patterns) {
      const m = text.match(pattern);
      if (m) {
        matches.push({
          rule_id: rule.id,
          urgency: 'emergency',
          description: rule.description,
          matched_text: m[0],
        });
        break;
      }
    }
  }

  if (matches.length > 0) return matches; // emergency short-circuits

  for (const rule of PHARMACIST_RULES) {
    for (const pattern of rule.patterns) {
      const m = text.match(pattern);
      if (m) {
        matches.push({
          rule_id: rule.id,
          urgency: 'pharmacist_review',
          description: rule.description,
          matched_text: m[0],
        });
        break;
      }
    }
  }

  return matches;
}

export function highestUrgency(matches: TriggerMatch[]): EscalationUrgency | null {
  if (matches.some((m) => m.urgency === 'emergency')) return 'emergency';
  if (matches.length > 0) return 'pharmacist_review';
  return null;
}
