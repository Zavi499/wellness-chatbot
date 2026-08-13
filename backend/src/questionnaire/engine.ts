/**
 * Questionnaire state machine.
 *
 * The hard rule from the source document, enforced here in code rather than
 * left to the prompt: before asking a question, check `answers` — if the key
 * is present, skip it (spec §4.1, §4.2).
 */
import {
  loadQuestionnaire,
  optionLabel,
  questionText,
  type Question,
  type QuestionnaireConfig,
  type QuestionnaireId,
} from './loader.js';
import type { AnswerMap, EscalationUrgency, Language, QuickReply } from '../types.js';

export function isApplicable(q: Question, answers: AnswerMap): boolean {
  if (!q.show_if) return true;
  const given = answers[q.show_if.key];
  if (given === undefined) return false;
  const values = Array.isArray(given) ? given : [given];
  return values.some((v) => q.show_if!.in.includes(v));
}

export function isAnswered(q: Question, answers: AnswerMap): boolean {
  const value = answers[q.key];
  if (value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  return String(value).trim() !== '';
}

/** The questions this session still needs, in order. */
export function pendingQuestions(cfg: QuestionnaireConfig, answers: AnswerMap): Question[] {
  return cfg.questions.filter((q) => isApplicable(q, answers) && !isAnswered(q, answers) && !q.optional);
}

export interface NextStep {
  question: Question | null;
  /** 1-based, for the "3 of 6" indicator. */
  step: number;
  total: number;
  done: boolean;
}

export function nextQuestion(id: QuestionnaireId, answers: AnswerMap): NextStep {
  const cfg = loadQuestionnaire(id);
  const applicable = cfg.questions.filter((q) => isApplicable(q, answers) && !q.optional);
  const answered = applicable.filter((q) => isAnswered(q, answers));
  const remaining = applicable.filter((q) => !isAnswered(q, answers));

  return {
    question: remaining[0] ?? null,
    step: Math.min(answered.length + 1, applicable.length),
    total: applicable.length,
    done: remaining.length === 0,
  };
}

export function quickRepliesFor(q: Question, language: Language): QuickReply[] {
  return q.options.map((o) => ({ label: optionLabel(o, language), value: o.value }));
}

export function promptFor(q: Question, language: Language): string {
  return questionText(q, language);
}

export interface AnswerEscalation {
  urgency: EscalationUrgency;
  reason: string;
  question_key: string;
  matched_value: string;
}

/**
 * Checks a newly recorded answer against the questionnaire's own escalation
 * rules (sensitive body areas, hair-loss red flags, pregnancy, medicines).
 * This runs regardless of what the model decided to do.
 */
export function escalationForAnswer(
  id: QuestionnaireId,
  questionKey: string,
  value: string | string[],
): AnswerEscalation | null {
  const cfg = loadQuestionnaire(id);
  const question = cfg.questions.find((q) => q.key === questionKey);
  if (!question?.escalate) return null;

  const values = Array.isArray(value) ? value : [value];
  const matched = values.find((v) => question.escalate!.values.includes(v));
  if (!matched) return null;

  return {
    urgency: question.escalate.urgency,
    reason: question.escalate.reason,
    question_key: questionKey,
    matched_value: matched,
  };
}

/** Maps the entry screen's `help_topic` answer onto a category questionnaire. */
export function questionnaireForTopic(topic: string | undefined): QuestionnaireId | null {
  switch (topic) {
    case 'face':
      return 'face';
    case 'body':
      return 'body';
    case 'hair':
      return 'hair';
    case 'vitamins':
      return 'vitamins';
    // "routine" and "compare" reuse the face flow to gather a baseline, then
    // branch in the orchestrator rather than having their own question set.
    case 'routine':
      return 'face';
    default:
      return null;
  }
}

/** Compact view of collected answers, injected into every model call. */
export function describeAnswers(answers: AnswerMap): string {
  const entries = Object.entries(answers);
  if (entries.length === 0) return '(nothing collected yet)';
  return entries
    .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join('\n');
}
