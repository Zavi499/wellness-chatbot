/**
 * OpenAI client wrapper.
 *
 * The API key is read from this service's environment only — it never appears
 * in PHP and is never shipped to the browser (spec §11).
 */
import OpenAI from 'openai';
import { config } from '../config.js';

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

/** Model tiers, resolved from config so a retired ID is a one-line env change. */
export const models = {
  /** Live conversation turns — balanced cost/quality. */
  chat: () => config.openai.chatModel,
  /** High-volume, low-risk work: language detection, query normalization. */
  cheap: () => config.openai.cheapModel,
  /** Product auto-labeling, where accuracy matters most. */
  label: () => config.openai.labelModel,
  /** Embeddings for semantic product/FAQ search. */
  embed: () => config.openai.embedModel,
};
