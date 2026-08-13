/**
 * One turn of conversation (spec §1.3).
 *
 * Order matters and is not negotiable: safety screening runs BEFORE the model
 * is ever called, so an emergency short-circuits to approved copy without an
 * API round trip and without any chance of the model selling into a crisis.
 */
import { randomUUID } from 'node:crypto';
import type OpenAI from 'openai';
import { openai, models } from '../openai/client.js';
import { config } from '../config.js';
import { getSettings, handoffOptions } from '../settings/repository.js';
import { detectLanguage, DEFAULT_LANGUAGE } from '../language/detect.js';
import { screenMessage, recordEscalation, summarizeForHandoff } from '../safety/engine.js';
import { HANDOFF_NOTICE, NO_SELLING_REMINDER } from '../safety/templates.js';
import { MASTER_SYSTEM_PROMPT, buildContextMessage } from './prompts/system.js';
import { TOOL_DEFINITIONS, executeTool, type ToolOutcome } from './tools.js';
import {
  appendTurn,
  blockSelling,
  lockLanguage,
  recentHistory,
  resumeOrCreate,
  saveSession,
} from './session.js';
import {
  nextQuestion,
  questionnaireForTopic,
  quickRepliesFor,
  promptFor,
} from '../questionnaire/engine.js';
import { optionLabel } from '../questionnaire/loader.js';
import { searchKb, answerIn } from '../kb/repository.js';
import { logEvent } from '../analytics/audit.js';
import type { ChatResponse, Language, QuickReply, SessionState } from '../types.js';

const MAX_TOOL_ROUNDS = 4;

export interface TurnInput {
  session_id?: string | null;
  message: string;
  /** Set when the customer tapped a quick-reply rather than typing. */
  answer?: { key: string; value: string | string[] };
}

export async function handleTurn(input: TurnInput): Promise<ChatResponse> {
  const session = resumeOrCreate(input.session_id);
  const message = (input.message ?? '').slice(0, 2000);

  // --- 1. Language: detect once, then lock (spec §6.1) ----------------------
  const detection = await detectLanguage(message, session.language);
  const language: Language = detection.language ?? session.language ?? DEFAULT_LANGUAGE;
  if (detection.language) lockLanguage(session, detection.language);

  appendTurn(session, 'user', message);

  // --- 2. Quick-reply answers are recorded before anything else ------------
  if (input.answer?.key) {
    session.answers[input.answer.key] = input.answer.value;
    logEvent('questionnaire_answered', session.session_id, input.answer);
  }

  // --- 3. Safety screen, before the model (spec §1.3 step 4, §5) -----------
  const screen = screenMessage(session, message, language);

  if (screen.triggered && screen.urgency) {
    const reason = screen.matches.map((m) => m.description).join('; ');
    blockSelling(session, reason, screen.urgency);
    recordEscalation({
      session,
      urgency: screen.urgency,
      reason,
      source: 'rule',
      matchedRule: screen.matches.map((m) => m.rule_id).join(','),
      language,
    });

    const text = [screen.sensitiveDataWarning, screen.message, HANDOFF_NOTICE[language]]
      .filter(Boolean)
      .join('\n\n');

    appendTurn(session, 'assistant', text);
    saveSession(session);

    return {
      session_id: session.session_id,
      message: text,
      language,
      quick_replies: [],
      escalation: {
        urgency: screen.urgency,
        reason,
        handoff: screen.handoff ?? handoffOptions(summarizeForHandoff(session, message), language),
      },
      message_id: randomUUID(),
      selling_blocked: session.escalation.selling_blocked,
    };
  }

  // --- 4. Assemble context for the model -----------------------------------
  const settings = getSettings();
  const retrieved = await retrieveContext(message, language);

  const topic = session.answers.help_topic;
  const questionnaireId = questionnaireForTopic(typeof topic === 'string' ? topic : undefined);
  const step = questionnaireId ? nextQuestion(questionnaireId, session.answers) : null;

  const contextMessage = buildContextMessage({
    language,
    answers: session.answers,
    settings,
    retrieved,
    sellingBlocked: session.escalation.selling_blocked,
    nextQuestion:
      step?.question && !session.escalation.selling_blocked
        ? {
            key: step.question.key,
            text: promptFor(step.question, language),
            options: step.question.options.map((o) => optionLabel(o, language)),
          }
        : null,
    progress: step && !step.done ? { step: step.step, total: step.total } : null,
  });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: MASTER_SYSTEM_PROMPT },
    { role: 'system', content: contextMessage },
    ...recentHistory(session).map((t) => ({ role: t.role, content: t.content })),
  ];

  // --- 5. Model call with tool loop ----------------------------------------
  let finalText = '';
  let recommendations: ChatResponse['recommendations'];
  let modelEscalation: { urgency: 'emergency' | 'pharmacist_review'; reason: string } | null = null;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const completion = await openai().chat.completions.create({
        model: models.chat(),
        messages,
        tools: TOOL_DEFINITIONS,
        tool_choice: 'auto',
      });

      const choice = completion.choices[0];
      const assistantMessage = choice?.message;
      if (!assistantMessage) break;

      messages.push(assistantMessage as OpenAI.Chat.Completions.ChatCompletionMessageParam);

      const toolCalls = assistantMessage.tool_calls ?? [];
      if (toolCalls.length === 0) {
        finalText = assistantMessage.content ?? '';
        break;
      }

      for (const call of toolCalls) {
        if (call.type !== 'function') continue;
        const outcome: ToolOutcome = await executeTool(call.function.name, call.function.arguments, {
          session,
          language,
        });

        if (outcome.recommendations) recommendations = outcome.recommendations;
        if (outcome.escalation) modelEscalation = outcome.escalation;

        messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.result });
      }
    }
  } catch (err) {
    // A model or network failure must not look like a confident answer.
    const text =
      language === 'ar'
        ? 'عذراً، حدث خلل تقني عندي الآن. يمكنني توصيلك بفريقنا، أو يمكنك المحاولة مرة أخرى بعد قليل.'
        : "Sorry — something went wrong on my side just now. I can connect you with our team, or you can try again in a moment.";
    appendTurn(session, 'assistant', text);
    saveSession(session);
    return {
      session_id: session.session_id,
      message: text,
      language,
      quick_replies: [],
      message_id: randomUUID(),
      selling_blocked: session.escalation.selling_blocked,
      escalation: {
        urgency: 'pharmacist_review',
        reason: `Backend error: ${err instanceof Error ? err.message : String(err)}`,
        handoff: handoffOptions(summarizeForHandoff(session, message), language),
      },
    };
  }

  // --- 6. Model-initiated escalation lands in the same log -----------------
  let escalationPayload: ChatResponse['escalation'];
  if (modelEscalation) {
    blockSelling(session, modelEscalation.reason, modelEscalation.urgency);
    recordEscalation({
      session,
      urgency: modelEscalation.urgency,
      reason: modelEscalation.reason,
      source: 'model',
      language,
    });
    escalationPayload = {
      urgency: modelEscalation.urgency,
      reason: modelEscalation.reason,
      handoff: handoffOptions(summarizeForHandoff(session, message), language),
    };
  }

  if (!finalText.trim()) {
    finalText = session.escalation.selling_blocked
      ? NO_SELLING_REMINDER[language]
      : language === 'ar'
        ? 'كيف يمكنني مساعدتك أكثر؟'
        : 'How else can I help?';
  }

  if (screen.sensitiveDataWarning) {
    finalText = `${screen.sensitiveDataWarning}\n\n${finalText}`;
  }

  // --- 7. Quick replies come from the questionnaire config, not the model ---
  const quickReplies: QuickReply[] =
    step?.question && !session.escalation.selling_blocked && !escalationPayload
      ? quickRepliesFor(step.question, language)
      : [];

  appendTurn(session, 'assistant', finalText);
  saveSession(session);
  logEvent('turn_completed', session.session_id, { language, had_recommendations: Boolean(recommendations) });

  return {
    session_id: session.session_id,
    message: finalText,
    language,
    quick_replies: quickReplies,
    recommendations,
    escalation: escalationPayload,
    progress: step && !step.done ? { step: step.step, total: step.total } : undefined,
    message_id: randomUUID(),
    selling_blocked: session.escalation.selling_blocked,
  };
}

/**
 * Retrieval for this turn: approved FAQ entries only. Product context arrives
 * through the tools instead, so the model can never name an unverified SKU it
 * merely saw in a retrieval blob.
 */
async function retrieveContext(message: string, language: Language): Promise<string[]> {
  if (!message.trim()) return [];
  try {
    const matches = await searchKb(message, 0.45, 3);
    return matches
      .map((m) => {
        const answer = answerIn(m.entry, language);
        return answer ? `FAQ — ${m.entry.topic}: ${answer}` : null;
      })
      .filter((v): v is string => v !== null);
  } catch {
    return [];
  }
}

/** Opening message for a fresh widget session. */
export function openingResponse(language: Language, greeting: string): ChatResponse {
  const session = resumeOrCreate(null);
  if (language) lockLanguage(session, language);
  saveSession(session);
  return {
    session_id: session.session_id,
    message: greeting,
    language,
    quick_replies: [],
    message_id: randomUUID(),
    selling_blocked: false,
  };
}

export { config as orchestratorConfig };
