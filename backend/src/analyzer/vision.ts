/**
 * The photo step.
 *
 * The image is a local parameter and nothing more: it is never written to
 * disk, never stored in the session, never logged, and never returned. Only
 * the model's derived reading survives the call. Face and scalp photos are
 * sensitive personal data and this service has no consent, retention or
 * deletion machinery for them — so it keeps none.
 */
import { openai, models } from '../openai/client.js';
import { loadQuestionnaire } from '../questionnaire/loader.js';
import type { Language } from '../types.js';
import type { AnalyzerDefinition } from './config.js';
import { visionSystemPrompt, visionUserPrompt } from './prompts.js';

export interface PhotoReading {
  usable: boolean;
  unusable_reason: string | null;
  refer_to_professional: boolean;
  summary: string | null;
  /** Validated answer keys → option values, ready to pre-fill the wizard. */
  suggested_answers: Record<string, string>;
}

/** Data URLs this accepts. Anything else is rejected before a token is spent. */
const DATA_URL = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/;

/** Hard ceiling on the decoded image, well under the route's body limit. */
export const MAX_IMAGE_BYTES = 700_000;

export type PhotoRejection = 'not_an_image' | 'too_large';

/**
 * Cheap structural checks before the expensive call. Returns null when the
 * payload is fine, or why it isn't.
 */
export function validateDataUrl(dataUrl: string): PhotoRejection | null {
  const match = DATA_URL.exec(dataUrl);
  if (!match) return 'not_an_image';
  // base64 is 4 chars per 3 bytes; compare without allocating the buffer.
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((match[2]!.length * 3) / 4) - padding;
  return bytes > MAX_IMAGE_BYTES ? 'too_large' : null;
}

/**
 * The options a given question actually offers, read from the questionnaire
 * itself rather than copied here — so editing a question's options through
 * the admin can never leave the vision schema suggesting a value the
 * questionnaire no longer accepts.
 */
function optionValues(questionnaireId: AnalyzerDefinition['questionnaire'], key: string): string[] {
  const cfg = loadQuestionnaire(questionnaireId);
  return cfg.questions.find((q) => q.key === key)?.options.map((o) => o.value) ?? [];
}

function buildSchema(def: AnalyzerDefinition): Record<string, unknown> {
  const suggested: Record<string, unknown> = {};
  for (const key of def.prefillable) {
    const values = optionValues(def.questionnaire, key);
    if (!values.length) continue;
    suggested[key] = {
      type: ['string', 'null'],
      enum: [...values, null],
      description: `What the photo suggests for "${key}", or null if the photo does not clearly show it.`,
    };
  }

  return {
    type: 'object',
    properties: {
      usable: { type: 'boolean', description: 'Can the subject actually be assessed from this photo?' },
      unusable_reason: {
        type: ['string', 'null'],
        description: 'If not usable, a short friendly note telling the customer what to change.',
      },
      refer_to_professional: {
        type: 'boolean',
        description: 'True if anything visible should be seen by a pharmacist or doctor rather than analysed here.',
      },
      summary: {
        type: ['string', 'null'],
        description: 'One or two sentences to the customer describing what you noticed, in cosmetic terms only.',
      },
      suggested_answers: {
        type: 'object',
        properties: suggested,
        required: Object.keys(suggested),
        additionalProperties: false,
      },
    },
    required: ['usable', 'unusable_reason', 'refer_to_professional', 'summary', 'suggested_answers'],
    additionalProperties: false,
  };
}

/**
 * Drops anything the model returned that the questionnaire would not accept.
 * Structured output already constrains this, but the pre-fill writes straight
 * into session answers that later drive eligibility and scoring, so it is
 * checked again here rather than trusted.
 */
export function sanitizeSuggestions(
  def: AnalyzerDefinition,
  raw: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;

  for (const key of def.prefillable) {
    const value = raw[key];
    if (typeof value !== 'string' || value === '') continue;
    // "not_sure" is a real option, but pre-filling it tells the customer
    // nothing and costs them a tap to change — leave it unanswered instead.
    if (value === 'not_sure' || value === 'none') continue;
    if (!optionValues(def.questionnaire, key).includes(value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * A reading that produces no pre-fill and no analysis — used whenever the
 * photo can't or shouldn't be interpreted.
 */
export function emptyReading(overrides: Partial<PhotoReading>): PhotoReading {
  return {
    usable: false,
    unusable_reason: null,
    refer_to_professional: false,
    summary: null,
    suggested_answers: {},
    ...overrides,
  };
}

export async function analyzePhoto(
  def: AnalyzerDefinition,
  dataUrl: string,
  language: Language,
): Promise<PhotoReading> {
  const model = models.vision();
  const response = await openai().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: visionSystemPrompt(def) },
      {
        role: 'user',
        content: [
          { type: 'text', text: visionUserPrompt(def, language) },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'wwc_photo_reading', strict: true, schema: buildSchema(def) },
    },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('Vision model returned no content.');

  const parsed = JSON.parse(content) as {
    usable?: boolean;
    unusable_reason?: string | null;
    refer_to_professional?: boolean;
    summary?: string | null;
    suggested_answers?: Record<string, unknown>;
  };

  const referred = parsed.refer_to_professional === true;
  return {
    usable: parsed.usable === true,
    unusable_reason: parsed.unusable_reason ?? null,
    refer_to_professional: referred,
    summary: parsed.summary ?? null,
    // A referral means "a human should look at this", so nothing from the
    // photo is allowed to steer the recommendation.
    suggested_answers:
      parsed.usable === true && !referred ? sanitizeSuggestions(def, parsed.suggested_answers) : {},
  };
}
