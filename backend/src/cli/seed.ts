/**
 * Seeds the bilingual lexicon and the FAQ knowledge base skeleton.
 *
 * The FAQ entries are created UNAPPROVED and with empty answers on purpose:
 * they are the Appendix C checklist of topics the store owner must fill in and
 * approve, not content this build invented (spec §7.1, §7.3).
 *
 *   npm run seed
 */
import { db, toJson } from '../db/index.js';
import { LEXICON_SEED } from '../search/lexicon.js';
import { upsertKb, listKb } from '../kb/repository.js';

interface FaqSeed {
  topic: string;
  question_en: string;
  question_ar: string;
}

const FAQ_TOPICS: FaqSeed[] = [
  { topic: 'delivery areas', question_en: 'Which areas do you deliver to?', question_ar: 'ما المناطق التي توصلون إليها؟' },
  { topic: 'delivery fee', question_en: 'How much is delivery?', question_ar: 'كم تبلغ رسوم التوصيل؟' },
  { topic: 'delivery time', question_en: 'How long does delivery take?', question_ar: 'كم يستغرق التوصيل؟' },
  { topic: 'free delivery threshold', question_en: 'Is there free delivery?', question_ar: 'هل يوجد توصيل مجاني؟' },
  { topic: 'order cut-off time', question_en: 'What time is the daily order cut-off?', question_ar: 'ما هو آخر موعد لاستلام الطلبات يومياً؟' },
  { topic: 'payment methods', question_en: 'Which payment methods do you accept?', question_ar: 'ما طرق الدفع المتاحة؟' },
  { topic: 'cash on delivery', question_en: 'Can I pay cash on delivery?', question_ar: 'هل يمكنني الدفع عند الاستلام؟' },
  { topic: 'returns policy', question_en: 'Can I return a product?', question_ar: 'هل يمكنني إرجاع منتج؟' },
  { topic: 'exchange policy', question_en: 'Can I exchange a product?', question_ar: 'هل يمكنني استبدال منتج؟' },
  { topic: 'refund timing', question_en: 'How long does a refund take?', question_ar: 'كم يستغرق استرداد المبلغ؟' },
  { topic: 'order tracking', question_en: 'How do I track my order?', question_ar: 'كيف أتتبع طلبي؟' },
  { topic: 'order changes', question_en: 'Can I change or cancel my order?', question_ar: 'هل يمكنني تعديل أو إلغاء طلبي؟' },
  { topic: 'account creation', question_en: 'Do I need an account to order?', question_ar: 'هل أحتاج إلى حساب لتقديم طلب؟' },
  { topic: 'loyalty programme', question_en: 'Do you have a loyalty programme?', question_ar: 'هل لديكم برنامج ولاء؟' },
  { topic: 'promotions', question_en: 'Do you have any current offers?', question_ar: 'هل لديكم عروض حالياً؟' },
  { topic: 'customer service hours', question_en: 'When can I reach your team?', question_ar: 'متى يمكنني التواصل مع فريقكم؟' },
  { topic: 'product authenticity', question_en: 'Are your products original?', question_ar: 'هل منتجاتكم أصلية؟' },
  { topic: 'product availability', question_en: 'When will an out-of-stock product return?', question_ar: 'متى سيتوفر المنتج غير المتاح؟' },
];

function seedLexicon(): number {
  const conn = db();
  const stmt = conn.prepare(
    `INSERT INTO lexicon (kind, canonical, name_en, name_ar, synonyms_en_json, synonyms_ar_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, canonical) DO UPDATE SET
       name_en = excluded.name_en,
       name_ar = excluded.name_ar,
       synonyms_en_json = excluded.synonyms_en_json,
       synonyms_ar_json = excluded.synonyms_ar_json`,
  );

  for (const entry of LEXICON_SEED) {
    stmt.run(
      entry.kind,
      entry.canonical,
      entry.name_en,
      entry.name_ar,
      toJson(entry.synonyms_en),
      toJson(entry.synonyms_ar),
    );
  }
  return LEXICON_SEED.length;
}

function seedFaqSkeleton(): number {
  const existing = new Set(listKb(true).map((e) => e.topic));
  let created = 0;

  for (const faq of FAQ_TOPICS) {
    if (existing.has(faq.topic)) continue;
    upsertKb({
      topic: faq.topic,
      question_en: faq.question_en,
      question_ar: faq.question_ar,
      answer_en: null,
      answer_ar: null,
      // Unapproved and empty: a human writes and approves the answer.
      approved: false,
      actor: 'seed',
    });
    created += 1;
  }
  return created;
}

function main(): void {
  const lexicon = seedLexicon();
  const faqs = seedFaqSkeleton();

  console.log(`Seeded ${lexicon} lexicon entries.`);
  console.log(`Created ${faqs} unanswered FAQ topics.`);
  console.log(
    '\nNext: open WordPress → Wellness Chatbot → Knowledge Base, write the answer for each topic\n' +
      'in English and Arabic, and approve it. Unapproved entries are never shown to a customer.',
  );
}

main();
