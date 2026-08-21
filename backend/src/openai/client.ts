/**
 * OpenAI client wrapper.
 *
 * The API key is read from this service's environment only — it never appears
 * in PHP and is never shipped to the browser (spec §11).
 */
import OpenAI from 'openai';
import { config } from '../config.js';
import { getModelOverrides } from '../settings/repository.js';

let client: OpenAI | null = null;

export function openai(): OpenAI {
  if (!client) {
    if (!config.openai.apiKey) {
      throw new Error(
        'OPENAI_API_KEY is not set. The chatbot backend cannot call OpenAI without it.',
      );
    }
    client = new OpenAI({ apiKey: config.openai.apiKey, maxRetries: 2, timeout: 60_000 });
  }
  return client;
}

/**
 * Model tiers. Checks the live, WordPress-settable override first (see
 * `settings/repository.ts` `getModelOverrides()`) and falls back to the
 * OPENAI_MODEL_* env var otherwise — so a wrong or retired model ID can be
 * fixed from the dashboard without SSH access or a redeploy. `embed` is
 * deliberately not overridable this way: changing the embedding model
 * changes vector dimensions, which needs a full re-index, not a live swap.
 */
export const models = {
  /** Live conversation turns — balanced cost/quality. */
  chat: () => getModelOverrides().chat ?? config.openai.chatModel,
  /** High-volume, low-risk work: language detection, query normalization. */
  cheap: () => getModelOverrides().cheap ?? config.openai.cheapModel,
  /** Product auto-labeling, where accuracy matters most. */
  label: () => getModelOverrides().label ?? config.openai.labelModel,
  /** Embeddings for semantic product/FAQ search. */
  embed: () => config.openai.embedModel,
};

/**
 * Every model id currently available to this API key, straight from OpenAI —
 * not a hardcoded list here, since any list baked into this codebase can go
 * stale the moment OpenAI ships or retires a model. Used to populate the
 * model picker in the WordPress dashboard.
 */
export async function listAvailableModels(): Promise<string[]> {
  const list = await openai().models.list();
  return list.data.map((m) => m.id).sort();
}
