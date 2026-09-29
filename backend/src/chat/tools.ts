/**
 * OpenAI tool definitions and their executors (spec §4.3).
 *
 * Each executor re-validates server-side — the model calling
 * `get_recommendations` never bypasses the eligibility filter.
 */
import type OpenAI from 'openai';
import { getSettings } from '../settings/repository.js';
import { searchKb, answerIn, KB_FALLBACK } from '../kb/repository.js';
import { searchProducts } from '../search/embeddings.js';
import { buildProfile } from '../recommend/profile.js';
import { selectTopThree, toRecommendationSet, toProductCards } from '../recommend/select.js';
import { findProducts, typeOnlyNote, type FindRequest } from '../recommend/find.js';
import { isProductCategory, type ProductCategory } from '../products/category.js';
import { PRODUCT_TYPE_KEYS, typeLabel } from '../products/types.js';
import { recordAnswer } from './session.js';
import { logEvent } from '../analytics/audit.js';
import type { Language, RecommendationSet, SessionState } from '../types.js';

export const TOOL_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_faq_answer',
      description:
        'Retrieve the approved answer for a store policy or service question (shipping, payment, returns, loyalty, accounts). Only call this for topics covered by the store\'s approved FAQ/policy knowledge base.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: "Short description of the customer's question, e.g. 'delivery fee', 'refund timing'",
          },
        },
        required: ['topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_questionnaire_answer',
      description:
        'Record the customer\'s answer to a product-finder question so it is never asked again this session.',
      parameters: {
        type: 'object',
        properties: {
          question_key: { type: 'string' },
          answer_value: { type: 'string' },
        },
        required: ['question_key', 'answer_value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_recommendations',
      description:
        'Run the recommendation engine against verified, in-stock products using the answers collected so far. Returns up to three ranked products with labels Best Overall Match / Best Value / Alternative Choice.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'One of: face, body, hair, vitamins, general' },
          must_exclude_product_ids: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Products already shown that the customer asked to replace',
          },
        },
        required: ['category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_products',
      description:
        'Find products for a need the customer describes in their own words — "a shampoo for dry scalp", "sunscreen for oily skin", "something for dandruff". ' +
        'Translate the request into the structured fields below; the engine then returns ONLY products of the requested type(s), best need-match first. ' +
        'product_types is required: pick what the customer physically wants. If they did not say (e.g. "something for dry skin"), ask one short question about the kind of product first instead of calling this.',
      parameters: {
        type: 'object',
        properties: {
          product_types: {
            type: 'array',
            items: { type: 'string', enum: PRODUCT_TYPE_KEYS },
            description:
              'Every type that satisfies the request, usually one. "shampoo" → ["shampoo"]; "sunscreen" → ["sunscreen","body_sunscreen"] only if they did not say face; "hair vitamins" → the supplement_* types. Never add a type the customer did not ask for.',
          },
          concerns: {
            type: 'array',
            items: { type: 'string' },
            description:
              'What it is for, in English: dryness, dandruff, hair loss, acne, pigmentation, frizz, odour … Read the request in context: "dry skin" in a shampoo request means a dry scalp → ["dry scalp", "dryness"].',
          },
          for_types: {
            type: 'array',
            items: { type: 'string' },
            description: 'Types it must suit, in English: dry, oily, sensitive, curly, coloured, fine … Empty if not stated.',
          },
          ingredients_wanted: { type: 'array', items: { type: 'string' } },
          ingredients_avoid: { type: 'array', items: { type: 'string' } },
          fragrance_free: { type: 'boolean' },
          budget: { type: 'string', enum: ['low', 'mid', 'high', 'any'] },
          must_exclude_product_ids: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Products already shown that the customer asked to replace.',
          },
        },
        required: ['product_types'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_products',
      description:
        'Look up a product the customer NAMES — a brand, a product name or a SKU ("CeraVe", "Nizoral shampoo", "do you have Bioderma Sensibio?"). ' +
        'Not for needs: "a shampoo for dandruff" is find_products.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The brand / product name as the customer wrote it.' } },
        required: ['query'],
      },
    },
  },
];

export interface ToolContext {
  session: SessionState;
  language: Language;
}

export interface ToolOutcome {
  /** JSON string handed back to the model. */
  result: string;
  /** Structured payload the widget renders, if this tool produced one. */
  recommendations?: RecommendationSet;
}

async function runGetFaqAnswer(args: { topic?: string }, ctx: ToolContext): Promise<ToolOutcome> {
  const topic = args.topic ?? '';
  const matches = await searchKb(topic);

  if (matches.length === 0) {
    logEvent('faq_no_answer', ctx.session.session_id, { topic });
    return {
      result: JSON.stringify({
        found: false,
        // The model must use this wording, not a paraphrase (spec §7.2).
        use_this_exact_answer: KB_FALLBACK[ctx.language],
      }),
    };
  }

  logEvent('faq_answered', ctx.session.session_id, { topic, entry_id: matches[0]!.entry.id });
  return {
    result: JSON.stringify({
      found: true,
      answers: matches.map((m) => ({
        topic: m.entry.topic,
        answer: answerIn(m.entry, ctx.language),
        confidence: Math.round(m.score * 100) / 100,
      })),
      note: 'Answer using only this approved text. Do not add details that are not here.',
    }),
  };
}

function runSubmitAnswer(
  args: { question_key?: string; answer_value?: string },
  ctx: ToolContext,
): ToolOutcome {
  const key = args.question_key ?? '';
  const value = args.answer_value ?? '';
  if (!key) return { result: JSON.stringify({ ok: false, error: 'question_key is required' }) };

  recordAnswer(ctx.session, key, value);
  return { result: JSON.stringify({ ok: true, recorded: { [key]: value } }) };
}

function runGetRecommendations(
  args: { category?: string; must_exclude_product_ids?: number[] },
  ctx: ToolContext,
): ToolOutcome {
  const requested = args.category ?? '';
  const fallback = ctx.session.answers.help_topic;
  const categoryKey = isProductCategory(requested)
    ? requested
    : typeof fallback === 'string' && isProductCategory(fallback)
      ? fallback
      : null;

  if (!categoryKey) {
    return {
      result: JSON.stringify({
        error: 'Unknown category. Ask the customer which area they need help with first.',
      }),
    };
  }

  const profile = buildProfile(categoryKey as ProductCategory, ctx.session.answers);
  const excludeIds = [
    ...(args.must_exclude_product_ids ?? []),
    ...ctx.session.last_recommendations.filter(() => false), // kept explicit: only what the model asked to exclude
  ];

  const selection = selectTopThree(profile, { excludeIds });
  const set = toRecommendationSet(selection, ctx.language);

  ctx.session.last_recommendations = set.items.map((i) => i.product_id);
  logEvent('recommendation_shown', ctx.session.session_id, {
    product_ids: ctx.session.last_recommendations,
    category: categoryKey,
    shortfall: selection.shortfall,
  });

  if (set.items.length === 0) {
    return {
      result: JSON.stringify({
        count: 0,
        message:
          'No eligible products matched. Tell the customer plainly that nothing in the current catalogue fits, and offer to connect them with the team. Do not invent alternatives.',
        rejected_summary: summarizeRejections(selection.outcome.rejected),
      }),
      recommendations: set,
    };
  }

  return {
    result: JSON.stringify({
      count: set.items.length,
      shortfall: selection.shortfall,
      disclaimer: set.disclaimer,
      items: set.items.map((i) => ({
        product_id: i.product_id,
        label: i.label,
        name: i.name,
        price: i.price,
        size: i.size,
        in_stock: i.in_stock,
        why_it_suits_you: i.why_it_suits_you,
        best_for: i.best_for,
        what_to_know: i.what_to_know,
        how_to_use: i.how_to_use,
      })),
      note: 'The cards are already shown to the customer. Summarise briefly; do not repeat every field verbatim.',
    }),
    recommendations: set,
  };
}

const FIND_NOTES = {
  need_type:
    'No product type was given. Ask the customer ONE short question about what kind of product they want (e.g. a shampoo, a cream, a supplement), then call find_products again.',
  medicine:
    'Medicines are never recommended by this assistant. If the customer named a specific medicine, look it up with search_products; otherwise suggest they speak to one of our pharmacists. Do not describe what any medicine treats.',
  none_of_type:
    'The store has no recommendable product of this type right now. Say so plainly and warmly. Do NOT offer a different kind of product instead unless the customer asks; you may offer to connect them with the team.',
} as const;

function runFindProducts(args: FindRequest & { must_exclude_product_ids?: number[] }, ctx: ToolContext): ToolOutcome {
  const request: FindRequest = {
    product_types: Array.isArray(args.product_types) ? args.product_types : [],
    concerns: Array.isArray(args.concerns) ? args.concerns : [],
    for_types: Array.isArray(args.for_types) ? args.for_types : [],
    ingredients_wanted: Array.isArray(args.ingredients_wanted) ? args.ingredients_wanted : [],
    ingredients_avoid: Array.isArray(args.ingredients_avoid) ? args.ingredients_avoid : [],
    fragrance_free: args.fragrance_free === true,
    budget: args.budget,
    exclude_ids: args.must_exclude_product_ids ?? [],
  };

  const found = findProducts(request);
  const typeNames = found.types.map((t) => typeLabel(t, ctx.language));

  if (!found.selection || found.selection.picks.length === 0) {
    logEvent('recommendation_shown', ctx.session.session_id, {
      product_ids: [],
      source: 'find_products',
      status: found.status,
      types: found.types,
    });
    const note =
      found.status === 'need_type' || found.status === 'medicine'
        ? FIND_NOTES[found.status]
        : FIND_NOTES.none_of_type;
    return { result: JSON.stringify({ count: 0, status: found.status, requested_types: typeNames, note }) };
  }

  const set = toRecommendationSet(found.selection, ctx.language);
  if (found.status === 'type_only') {
    set.shortfall_note = typeOnlyNote(request, found.types, ctx.language);
  }

  ctx.session.last_recommendations = set.items.map((i) => i.product_id);
  logEvent('recommendation_shown', ctx.session.session_id, {
    product_ids: ctx.session.last_recommendations,
    source: 'find_products',
    status: found.status,
    types: found.types,
    shortfall: found.selection.shortfall,
  });

  return {
    result: JSON.stringify({
      count: set.items.length,
      status: found.status,
      requested_types: typeNames,
      matching_need: found.matching_need,
      items: set.items.map((i) => ({
        product_id: i.product_id,
        label: i.label,
        name: i.name,
        best_for: i.best_for,
        why_it_suits_you: i.why_it_suits_you,
      })),
      note:
        found.status === 'type_only'
          ? 'None of these is specifically labelled for the stated need — they are the same type of product only. Say that honestly in one sentence (the cards also show a note). The cards are already shown; do not retype names, prices or details.'
          : 'Every product shown is of the requested type and matches the stated need. The cards are already shown; introduce them in a sentence, do not retype names, prices or details.',
    }),
    recommendations: set,
  };
}

function summarizeRejections(rejected: { reasons: string[] }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rejected) {
    for (const reason of r.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

async function runSearchProducts(args: { query?: string }, ctx: ToolContext): Promise<ToolOutcome> {
  const hits = await searchProducts(args.query ?? '', 6);
  // Only verified, in-stock products may be named to a customer (spec §3.4).
  const visible = hits.filter(
    (h) =>
      ['verified', 'partial'].includes(h.product.verification_status) &&
      h.product.stock_status !== 'outofstock',
  );

  return {
    result: JSON.stringify({
      count: visible.length,
      results: visible.map((h) => ({
        product_id: h.product.product_id,
        name: ctx.language === 'ar' ? (h.product.name_ar ?? h.product.name) : h.product.name,
        brand: h.product.brand,
        price: h.product.price ? `${h.product.price.toFixed(3)} ${h.product.currency}` : null,
        size: h.product.size,
        key_ingredients: h.product.key_ingredients,
        in_stock: h.product.stock_status === 'instock',
      })),
      note:
        visible.length === 0
          ? 'Nothing verified matched. Say so plainly and offer to connect the customer with the team.'
          : // Same contract as get_recommendations: the customer is already
            // looking at real cards with price, stock and an Add to cart
            // button, so re-typing those details as prose duplicates the card
            // badly and loses the button.
            'Only these products may be named. Do not mention any product not in this list. The cards are already shown to the customer — introduce them in a sentence, do not restate each product\'s name, price or details in your reply.',
    }),
    recommendations: visible.length ? toProductCards(visible.map((h) => h.product), ctx.language) : undefined,
  };
}

export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs || '{}') as Record<string, unknown>;
  } catch {
    return { result: JSON.stringify({ error: 'Could not parse tool arguments.' }) };
  }

  switch (name) {
    case 'get_faq_answer':
      return runGetFaqAnswer(args as { topic?: string }, ctx);
    case 'submit_questionnaire_answer':
      return runSubmitAnswer(args as { question_key?: string; answer_value?: string }, ctx);
    case 'get_recommendations':
      return runGetRecommendations(args as { category?: string; must_exclude_product_ids?: number[] }, ctx);
    case 'find_products':
      return runFindProducts(args as unknown as FindRequest & { must_exclude_product_ids?: number[] }, ctx);
    case 'search_products':
      return runSearchProducts(args as { query?: string }, ctx);
    default:
      return { result: JSON.stringify({ error: `Unknown tool: ${name}` }) };
  }
}

/** Business settings are read fresh on every turn, never cached into a prompt. */
export function currentSettings() {
  return getSettings();
}
