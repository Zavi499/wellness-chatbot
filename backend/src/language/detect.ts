/**
 * Language detection and lock (spec §6.1).
 *
 * A script-ratio heuristic settles the overwhelming majority of messages with
 * no API call. Only genuinely mixed input escalates to the cheap model, and if
 * that is still unclear the caller asks the customer once and then locks.
 */
import { openai, models } from '../openai/client.js';
import type { Language } from '../types.js';

export interface DetectionResult {
  language: Language | null;
  confidence: number;
  method: 'script' | 'model' | 'ambiguous';
}

const ARABIC_RANGE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g;
const LATIN_RANGE = /[A-Za-z]/g;

/** Pure heuristic — no network, safe to run on every turn. */
export function detectByScript(message: string): DetectionResult {
  const arabic = (message.match(ARABIC_RANGE) ?? []).length;
  const latin = (message.match(LATIN_RANGE) ?? []).length;
  const total = arabic + latin;

  if (total === 0) return { language: null, confidence: 0, method: 'ambiguous' };

  const arabicRatio = arabic / total;

  // A clear majority wins. Brand names stay in Latin script inside Arabic
  // sentences, so the Arabic threshold sits well below 100%. Anything in
  // between is genuinely mixed: the spec says ask once rather than guess.
  if (arabicRatio >= 0.6) return { language: 'ar', confidence: arabicRatio, method: 'script' };
  if (arabicRatio <= 0.15) return { language: 'en', confidence: 1 - arabicRatio, method: 'script' };

  return { language: null, confidence: 0.5, method: 'ambiguous' };
}

/** Fallback for mixed input. Uses the cheapest model tier (spec §2). */
export async function detectByModel(message: string): Promise<DetectionResult> {
  try {
    const res = await openai().chat.completions.create({
      model: models.cheap(),
      messages: [
        {
          role: 'system',
          content:
            'Identify the dominant language of the user message. Reply with exactly one word: "english", "arabic", or "unclear". No punctuation, no explanation.',
        },
        { role: 'user', content: message.slice(0, 500) },
      ],
      max_tokens: 5,
    });
    const answer = res.choices[0]?.message?.content?.trim().toLowerCase() ?? '';
    if (answer.startsWith('ar')) return { language: 'ar', confidence: 0.8, method: 'model' };
    if (answer.startsWith('en')) return { language: 'en', confidence: 0.8, method: 'model' };
    return { language: null, confidence: 0, method: 'ambiguous' };
  } catch {
    return { language: null, confidence: 0, method: 'ambiguous' };
  }
}

/**
 * Detects the customer's language. Callers pass the already-locked language to
 * short-circuit: once locked, the assistant never switches unless the customer
 * does (which the caller detects as a sustained script flip).
 */
export async function detectLanguage(
  message: string,
  locked: Language | null = null,
): Promise<DetectionResult> {
  const script = detectByScript(message);

  if (locked) {
    // Only a confident, clear switch by the customer unlocks the language.
    if (script.language && script.language !== locked && script.confidence >= 0.8) {
      return script;
    }
    return { language: locked, confidence: 1, method: 'script' };
  }

  if (script.language) return script;
  return detectByModel(message);
}

/** Default when the customer has not written anything yet. */
export const DEFAULT_LANGUAGE: Language = 'en';
