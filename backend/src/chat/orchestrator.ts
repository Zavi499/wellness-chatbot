/**
 * One turn of conversation (spec §1.3).
 *
 * The rule-based emergency/pharmacist-review safety screen that used to run
 * before every model call was removed by explicit store-owner decision, along
 * with the "escalate to a human" tool and the selling-block it triggered —
 * see `safety/engine.ts`. Sensitive-data detection (§5.4) is unrelated to
 * that removal and still runs on every turn.
 */
import { randomUUID } from 'node:crypto';
import type OpenAI from 'openai';
import { openai, models } from '../openai/client.js';
import { config } from '../config.js';
import { getSettings } from '../settings/repository.js';
import { detectLanguage, DEFAULT_LANGUAGE } from '../language/detect.js';
import { containsSensitiveData } from '../safety/engine.js';
import { SENSITIVE_DATA_WARNING } from '../safety/templates.js';
import { MASTER_SYSTEM_PROMPT, buildContextMessage } from './prompts/system.js';
import { TOOL_DEFINITIONS, executeTool, type ToolOutcome } from './tools.js';
import { appendTurn, lockLanguage, recentHistory, resumeOrCreate, saveSession } from './session.js';
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

  // --- 3. Sensitive data (§5.4) — unrelated to escalation, still checked ---
  const sensitiveDataWarning = containsSensitiveData(message) ? SENSITIVE_DATA_WARNING[language] : null;

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
    nextQuestion: step?.question
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

        messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.result });
      }
    }
  } catch (err) {
    // A model or network failure must not look like a confident answer.
    const text =
      language === 'ar'
        ? 'عذراً، حدث خلل تقني عندي الآن. يمكنك المحاولة مرة أخرى بعد قليل.'
        : 'Sorry — something went wrong on my side just now. You can try again in a moment.';
    appendTurn(session, 'assistant', text);
    saveSession(session);
    return {
      session_id: session.session_id,
      message: text,
      language,
      quick_replies: [],
      message_id: randomUUID(),
    };
  }

  if (!finalText.trim()) {
    finalText = language === 'ar' ? 'كيف يمكنني مساعدتك أكثر؟' : 'How else can I help?';
  }

  if (sensitiveDataWarning) {
    finalText = `${sensitiveDataWarning}\n\n${finalText}`;
  }

  // --- 6. Quick replies come from the questionnaire config, not the model ---
  const quickReplies: QuickReply[] = step?.question ? quickRepliesFor(step.question, language) : [];

  appendTurn(session, 'assistant', finalText);
  saveSession(session);
  logEvent('turn_completed', session.session_id, { language, had_recommendations: Boolean(recommendations) });

  return {
    session_id: session.session_id,
    message: finalText,
    language,
    quick_replies: quickReplies,
    recommendations,
    progress: step && !step.done ? { step: step.step, total: step.total } : undefined,
    message_id: randomUUID(),
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
  };
}

export { config as orchestratorConfig };
