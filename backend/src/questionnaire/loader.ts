/**
 * Questionnaire configuration (spec §4.4).
 *
 * Questions are data, not prose in the system prompt, so a non-engineer can
 * edit them from the admin screen without a deploy. Files in `data/questionnaire`
 * override the shipped defaults, which is where admin edits are written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import type { Language } from '../types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface QuestionOption {
  value: string;
  label_en: string;
  label_ar: string;
}

export interface EscalationRule {
  values: string[];
  urgency: 'emergency' | 'pharmacist_review';
  reason: string;
}

export interface Question {
  key: string;
  text_en: string;
  text_ar: string;
  type: 'single' | 'multi';
  options: QuestionOption[];
  /** Only ask when a previous answer matches. */
  show_if?: { key: string; in: string[] };
  optional?: boolean;
  /** Asks about type/ingredient knowledge — must offer an "I'm not sure" option. */
  knowledge_question?: boolean;
  privacy_sensitive?: boolean;
  escalate?: EscalationRule;
}

export interface QuestionnaireConfig {
  id: string;
  title_en: string;
  title_ar: string;
  questions: Question[];
  requires_pharmacist_verified_catalogue?: boolean;
  notice_en?: string;
  notice_ar?: string;
}

const IDS = ['entry', 'face', 'body', 'hair', 'vitamins'] as const;
export type QuestionnaireId = (typeof IDS)[number];

function overrideDir(): string {
  return path.join(path.dirname(config.db.path), 'questionnaire');
}

function defaultDir(): string {
  const candidates = [
    path.join(here, 'config'),
    path.join(here, '..', '..', 'src', 'questionnaire', 'config'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0]!;
}

const cache = new Map<string, QuestionnaireConfig>();

export function loadQuestionnaire(id: QuestionnaireId): QuestionnaireConfig {
  const cached = cache.get(id);
  if (cached) return cached;

  const override = path.join(overrideDir(), `${id}.json`);
  const file = fs.existsSync(override) ? override : path.join(defaultDir(), `${id}.json`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as QuestionnaireConfig;

  const problems = validateQuestionnaire(parsed);
  if (problems.length) {
    throw new Error(`Questionnaire "${id}" failed validation:\n- ${problems.join('\n- ')}`);
  }

  cache.set(id, parsed);
  return parsed;
}

export function loadAllQuestionnaires(): Record<string, QuestionnaireConfig> {
  const out: Record<string, QuestionnaireConfig> = {};
  for (const id of IDS) out[id] = loadQuestionnaire(id);
  return out;
}

/** Persists an admin edit, then drops the cache so the next read picks it up. */
export function saveQuestionnaire(id: QuestionnaireId, cfg: QuestionnaireConfig): string[] {
  const problems = validateQuestionnaire(cfg);
  if (problems.length) return problems;
  const dir = overrideDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(cfg, null, 2), 'utf8');
  cache.delete(id);
  return [];
}

export function clearQuestionnaireCache(): void {
  cache.clear();
}

/**
 * Enforces the question-writing rules from spec §4.4 so future edits stay
 * compliant: 4–7 options per screen, an "I'm not sure" escape hatch wherever
 * product knowledge is assumed, and bilingual text everywhere.
 */
export function validateQuestionnaire(cfg: QuestionnaireConfig): string[] {
  const problems: string[] = [];
  if (!cfg.id) problems.push('Missing id');
  if (!Array.isArray(cfg.questions) || cfg.questions.length === 0) {
    problems.push('Questionnaire has no questions');
    return problems;
  }

  const seen = new Set<string>();
  for (const q of cfg.questions) {
    const where = `question "${q.key}"`;
    if (!q.key) problems.push('A question is missing its key');
    if (seen.has(q.key)) problems.push(`Duplicate question key "${q.key}"`);
    seen.add(q.key);

    if (!q.text_en?.trim()) problems.push(`${where} is missing English text`);
    if (!q.text_ar?.trim()) problems.push(`${where} is missing Arabic text`);
    if (q.type !== 'single' && q.type !== 'multi') problems.push(`${where} has an invalid type`);

    const count = q.options?.length ?? 0;
    // One question and 4–7 answer choices per mobile screen. Three is allowed
    // for genuinely binary-ish questions (yes/sometimes/no) — fewer is not.
    if (count < 3) problems.push(`${where} has ${count} options; needs at least 3`);
    if (count > 7) problems.push(`${where} has ${count} options; the mobile limit is 7`);

    for (const o of q.options ?? []) {
      if (!o.value) problems.push(`${where} has an option with no value`);
      if (!o.label_en?.trim()) problems.push(`${where} option "${o.value}" is missing an English label`);
      if (!o.label_ar?.trim()) problems.push(`${where} option "${o.value}" is missing an Arabic label`);
    }

    if (q.knowledge_question && !q.options?.some((o) => o.value === 'not_sure')) {
      problems.push(`${where} asks about product knowledge but has no "not_sure" option`);
    }

    if (q.show_if && !cfg.questions.some((other) => other.key === q.show_if!.key)) {
      problems.push(`${where} depends on "${q.show_if.key}", which is not in this questionnaire`);
    }

    if (q.escalate) {
      const valid = new Set((q.options ?? []).map((o) => o.value));
      for (const v of q.escalate.values) {
        if (!valid.has(v)) problems.push(`${where} escalates on "${v}", which is not one of its options`);
      }
      if (!q.escalate.reason?.trim()) problems.push(`${where} has an escalation rule with no reason`);
    }
  }

  return problems;
}

export function questionText(q: Question, language: Language): string {
  return language === 'ar' ? q.text_ar : q.text_en;
}

export function optionLabel(o: QuestionOption, language: Language): string {
  return language === 'ar' ? o.label_ar : o.label_en;
}
