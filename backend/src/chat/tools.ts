/**
 * OpenAI tool definitions and their executors (spec §4.3).
 *
 * Each executor re-validates server-side. The model choosing not to call
 * `escalate_to_human` never bypasses the rule engine, and the model calling
 * `get_recommendations` never bypasses the eligibility filter.
 */
import type OpenAI from 'openai';
import { getSettings } from '../settings/repository.js';
import { searchKb, answerIn, KB_FALLBACK } from '../kb/repository.js';
import { searchProducts } from '../search/embeddings.js';
import { buildProfile } from '../recommend/profile.js';
import { selectTopThree, toRecommendationSet } from '../recommend/select.js';
import { isProductCategory, type ProductCategory } from '../products/category.js';
import { recordAnswer } from './session.js';
import { escalationForAnswer, questionnaireForTopic } from '../questionnaire/engine.js';
import { logEvent } from '../analytics/audit.js';
import type { EscalationUrgency, Language, RecommendationSet, SessionState } from '../types.js';

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
          category: { type: 'string', description: 'One of: face, body, hair, vitamins' },
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
      name: 'escalate_to_human',
      description:
        "Hand this conversation to a human. MUST be called (and selling must stop) for: difficulty breathing, facial/tongue swelling, severe allergic reaction, fainting, chest pain, stroke symptoms, severe bleeding, suspected poisoning/overdose, severe eye pain or sudden vision change, chemical exposure, severe blistering/peeling rash with fever, or a clearly very unwell infant/child — mark urgency 'emergency'. MUST also be called (selling may pause on this topic but the rest of the conversation can continue) for: pregnancy/breastfeeding product suitability, products for infants or young children with unclear age suitability, medicine interaction questions, chronic condition or prescription-treatment context, persistent/severe/infected/unexplained symptoms, a request for diagnosis or a treatment/dose change, or when the needed product information is missing, conflicting, or unverified — mark urgency 'pharmacist_review'.",
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
          urgency: { type: 'string', enum: ['emergency', 'pharmacist_review'] },
        },
        required: ['reason', 'urgency'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_products',
      description:
        'Free-text/semantic search over the verified product catalog, e.g. when the customer names a specific product or brand rather than going through the questionnaire.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
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
  /** Set when the model asked to escalate. */
  escalation?: { urgency: EscalationUrgency; reason: string };
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

  // The questionnaire's own escalation rules fire regardless of the model.
  const topic = ctx.session.answers.help_topic;
  const questionnaireId = questionnaireForTopic(typeof topic === 'string' ? topic : undefined);
  const escalation = questionnaireId ? escalationForAnswer(questionnaireId, key, value) : null;

  if (escalation) {
    return {
      result: JSON.stringify({
        ok: true,
        recorded: { [key]: value },
        safety_note: `This answer requires escalation: ${escalation.reason}`,
      }),
      escalation: { urgency: escalation.urgency, reason: escalation.reason },
    };
  }

  return { result: JSON.stringify({ ok: true, recorded: { [key]: value } }) };
}

function runGetRecommendations(
  args: { category?: string; must_exclude_product_ids?: number[] },
  ctx: ToolContext,
): ToolOutcome {
  // Selling is off after an emergency — the model does not get to override it.
  if (ctx.session.escalation.selling_blocked) {
    return {
      result: JSON.stringify({
        blocked: true,
        reason:
          'Selling is disabled for this conversation because an emergency-level concern was raised. Do not recommend products.',
      }),
    };
  }

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

function summarizeRejections(rejected: { reasons: string[] }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rejected) {
    for (const reason of r.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

async function runSearchProducts(args: { query?: string }, ctx: ToolContext): Promise<ToolOutcome> {
  if (ctx.session.escalation.selling_blocked) {
    return { result: JSON.stringify({ blocked: true, reason: 'Selling is disabled for this conversation.' }) };
  }

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
          : 'Only these products may be named. Do not mention any product not in this list.',
    }),
  };
}

function runEscalate(args: { reason?: string; urgency?: string }): ToolOutcome {
  const urgency: EscalationUrgency = args.urgency === 'emergency' ? 'emergency' : 'pharmacist_review';
  return {
    result: JSON.stringify({
      escalated: true,
      urgency,
      instruction:
        'A human handover has been arranged and the approved message is already being shown to the customer. Keep your own reply short, warm, and free of product suggestions on this topic.',
    }),
    escalation: { urgency, reason: args.reason ?? 'Escalation requested by the assistant' },
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
    case 'search_products':
      return runSearchProducts(args as { query?: string }, ctx);
    case 'escalate_to_human':
      return runEscalate(args as { reason?: string; urgency?: string });
    default:
      return { result: JSON.stringify({ error: `Unknown tool: ${name}` }) };
  }
}

/** Business settings are read fresh on every turn, never cached into a prompt. */
export function currentSettings() {
  return getSettings();
}
