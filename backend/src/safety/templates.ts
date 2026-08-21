/**
 * Approved copy (spec §5.4, §6).
 *
 * These strings are approved wording, not prompt suggestions — the orchestrator
 * returns them verbatim instead of letting the model improvise. They are the
 * one place in the system where the assistant speaks without the model.
 */
import type { Language } from '../types.js';

/** Shown when the customer pastes something they should not (spec §5.4). */
export const SENSITIVE_DATA_WARNING: Record<Language, string> = {
  en: "Please don't share card numbers, passwords or ID numbers in this chat — I've not stored what you sent. For anything account- or payment-related, our team will verify you through the store's secure process.",
  ar: 'من فضلك لا تشارك أرقام البطاقات أو كلمات المرور أو أرقام الهوية في هذه المحادثة — ولم أحتفظ بما أرسلته. ولأي أمر يتعلق بالحساب أو الدفع، سيتحقق فريقنا من هويتك عبر الإجراء الآمن المعتمد في المتجر.',
};

export const PRIVACY_NOTICE: Record<Language, string> = {
  en: 'Your answers are used only to suggest suitable products in this chat, and our team may review conversations to improve the service. Please do not share payment or ID details here.',
  ar: 'تُستخدم إجاباتك فقط لاقتراح منتجات مناسبة في هذه المحادثة، وقد يطّلع فريقنا على المحادثات لتحسين الخدمة. يرجى عدم مشاركة بيانات الدفع أو الهوية هنا.',
};

export const GREETING: Record<Language, string> = {
  en: "Hello! I'm the Wellness World assistant. I can help you find the right product, or answer a question about the store. What would you like help with today?",
  ar: 'أهلاً! أنا مساعد Wellness World. يمكنني مساعدتك في اختيار المنتج المناسب أو الإجابة عن أسئلتك حول المتجر. بماذا تحب أن أساعدك اليوم؟',
};

export const LANGUAGE_PROMPT =
  'Would you prefer to continue in English or Arabic? / هل تفضل المتابعة بالإنجليزية أم بالعربية؟';
