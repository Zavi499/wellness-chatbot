/**
 * Approved escalation copy (spec §5.1, §5.2, §5.4).
 *
 * These strings are approved wording, not prompt suggestions — the orchestrator
 * returns them verbatim instead of letting the model improvise. They are the
 * one place in the system where the assistant speaks without the model.
 */
import type { Language } from '../types.js';

export const EMERGENCY_TEMPLATE: Record<Language, string> = {
  en: `This sounds like it could be urgent, and it needs a person, not a shopping assistant.

Please contact your local emergency services or go to the nearest urgent care or hospital now. In Kuwait you can call **112**.

I've stopped product suggestions for this conversation. Once everything is okay, our team is here whenever you want to pick things back up.`,
  ar: `يبدو أن هذا قد يكون أمراً عاجلاً، ويحتاج إلى شخص مختص وليس إلى مساعد تسوّق.

يرجى الاتصال بخدمات الطوارئ أو التوجه إلى أقرب مستشفى أو طوارئ الآن. في الكويت يمكنك الاتصال بالرقم **112**.

لقد أوقفت اقتراح المنتجات في هذه المحادثة. وعندما تطمئن، فريقنا موجود متى أردت المتابعة.`,
};

export const PHARMACIST_TEMPLATE: Record<Language, string> = {
  en: `That's an important question, and I want to get it right rather than guess.

Let me check whether we have pharmacist-approved guidance for it. If we don't, I'll connect you with our specialist so you get a proper answer.

I'll hold off on recommending anything for that specific question until then — happy to keep helping with anything else in the meantime.`,
  ar: `هذا سؤال مهم، وأفضّل أن تكون الإجابة دقيقة بدلاً من التخمين.

دعني أتحقق مما إذا كانت لدينا إرشادات معتمدة من صيدلي بخصوصه. وإن لم تتوفر، سأوصلك بالمختص لدينا للحصول على إجابة صحيحة.

سأتوقف عن اقتراح أي منتج بخصوص هذا السؤال تحديداً حتى ذلك الحين — ويسعدني مساعدتك في أي أمر آخر في هذه الأثناء.`,
};

export const HANDOFF_NOTICE: Record<Language, string> = {
  en: "I'm passing this to a human from our team so you don't have to repeat yourself.",
  ar: 'سأحوّل هذه المحادثة إلى أحد أفراد فريقنا حتى لا تضطر لإعادة الشرح.',
};

/** Shown when the customer pastes something they should not (spec §5.4). */
export const SENSITIVE_DATA_WARNING: Record<Language, string> = {
  en: "Please don't share card numbers, passwords or ID numbers in this chat — I've not stored what you sent. For anything account- or payment-related, our team will verify you through the store's secure process.",
  ar: 'من فضلك لا تشارك أرقام البطاقات أو كلمات المرور أو أرقام الهوية في هذه المحادثة — ولم أحتفظ بما أرسلته. ولأي أمر يتعلق بالحساب أو الدفع، سيتحقق فريقنا من هويتك عبر الإجراء الآمن المعتمد في المتجر.',
};

export const NO_SELLING_REMINDER: Record<Language, string> = {
  en: "I'm not able to suggest products in this conversation any more — please speak with our team or a healthcare professional.",
  ar: 'لم يعد بإمكاني اقتراح منتجات في هذه المحادثة — يرجى التحدث مع فريقنا أو مع مختص رعاية صحية.',
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

export function templateFor(urgency: 'emergency' | 'pharmacist_review', language: Language): string {
  return urgency === 'emergency' ? EMERGENCY_TEMPLATE[language] : PHARMACIST_TEMPLATE[language];
}
