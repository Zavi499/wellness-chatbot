/**
 * Bilingual reference table (spec §6.2) and search normalization seeds (§6.3).
 *
 * This is the *seed* set taken from the source blueprint's examples. The store
 * owner extends it from the admin KB editor during setup — it is not meant to
 * be exhaustive on day one, and embeddings cover the long tail of misspellings
 * that no lookup table can enumerate.
 */

export interface LexiconEntry {
  kind: 'category' | 'brand' | 'ingredient' | 'concern' | 'product_type';
  canonical: string;
  name_en: string;
  name_ar: string;
  synonyms_en: string[];
  synonyms_ar: string[];
}

export const LEXICON_SEED: LexiconEntry[] = [
  // --- Product types -------------------------------------------------------
  {
    kind: 'product_type',
    canonical: 'cleanser',
    name_en: 'Cleanser',
    name_ar: 'غسول',
    synonyms_en: ['cleanser', 'face wash', 'facial cleanser', 'facewash', 'cleansing gel'],
    synonyms_ar: ['غسول', 'غسول وجه', 'منظف', 'منظف للوجه', 'غسول الوجه'],
  },
  {
    kind: 'product_type',
    canonical: 'moisturizer',
    name_en: 'Moisturizer',
    name_ar: 'مرطب',
    synonyms_en: ['moisturizer', 'moisturiser', 'cream', 'hydrator', 'day cream', 'night cream'],
    synonyms_ar: ['مرطب', 'كريم', 'كريم مرطب', 'مرطب الوجه'],
  },
  {
    kind: 'product_type',
    canonical: 'sunscreen',
    name_en: 'Sunscreen',
    name_ar: 'واقي شمس',
    synonyms_en: ['sunscreen', 'sunblock', 'sun block', 'spf', 'sun cream', 'uv protection'],
    synonyms_ar: ['واقي شمس', 'صن بلوك', 'واقي الشمس', 'كريم شمس', 'حماية من الشمس'],
  },
  {
    kind: 'product_type',
    canonical: 'serum',
    name_en: 'Serum',
    name_ar: 'سيروم',
    synonyms_en: ['serum', 'ampoule', 'concentrate', 'treatment'],
    synonyms_ar: ['سيروم', 'مصل', 'مركز'],
  },
  {
    kind: 'product_type',
    canonical: 'toner',
    name_en: 'Toner',
    name_ar: 'تونر',
    synonyms_en: ['toner', 'essence', 'tonic'],
    synonyms_ar: ['تونر', 'تونيك', 'ماء مقشر'],
  },
  {
    kind: 'product_type',
    canonical: 'shampoo',
    name_en: 'Shampoo',
    name_ar: 'شامبو',
    synonyms_en: ['shampoo', 'hair wash'],
    synonyms_ar: ['شامبو', 'غسول شعر'],
  },
  {
    kind: 'product_type',
    canonical: 'conditioner',
    name_en: 'Conditioner',
    name_ar: 'بلسم',
    synonyms_en: ['conditioner', 'hair mask', 'hair balm'],
    synonyms_ar: ['بلسم', 'ماسك شعر', 'حمام كريم'],
  },
  {
    kind: 'product_type',
    canonical: 'supplement',
    name_en: 'Supplement',
    name_ar: 'مكمل غذائي',
    synonyms_en: ['supplement', 'vitamin', 'tablet', 'capsule', 'multivitamin', 'gummies'],
    synonyms_ar: ['مكمل', 'مكمل غذائي', 'فيتامين', 'حبوب', 'كبسولات'],
  },
  {
    kind: 'product_type',
    canonical: 'deodorant',
    name_en: 'Deodorant',
    name_ar: 'مزيل عرق',
    synonyms_en: ['deodorant', 'antiperspirant', 'roll on'],
    synonyms_ar: ['مزيل عرق', 'مزيل رائحة', 'رول أون'],
  },

  // --- Concerns ------------------------------------------------------------
  {
    kind: 'concern',
    canonical: 'acne',
    name_en: 'Acne',
    name_ar: 'حب الشباب',
    synonyms_en: ['acne', 'pimples', 'breakouts', 'spots', 'zits', 'blemishes'],
    synonyms_ar: ['حب الشباب', 'حبوب', 'بثور', 'رؤوس سوداء'],
  },
  {
    kind: 'concern',
    canonical: 'dryness',
    name_en: 'Dryness',
    name_ar: 'الجفاف',
    synonyms_en: ['dryness', 'dry skin', 'dehydrated', 'flaky', 'tightness'],
    synonyms_ar: ['جفاف', 'بشرة جافة', 'تقشر', 'شد'],
  },
  {
    kind: 'concern',
    canonical: 'pigmentation',
    name_en: 'Pigmentation',
    name_ar: 'التصبغات',
    synonyms_en: ['pigmentation', 'dark spots', 'melasma', 'uneven tone', 'hyperpigmentation', 'brightening'],
    synonyms_ar: ['تصبغات', 'بقع داكنة', 'كلف', 'توحيد اللون', 'تفتيح'],
  },
  {
    kind: 'concern',
    canonical: 'ageing',
    name_en: 'Signs of ageing',
    name_ar: 'علامات التقدم في السن',
    synonyms_en: ['ageing', 'aging', 'wrinkles', 'fine lines', 'firmness', 'anti-age', 'anti aging'],
    synonyms_ar: ['التجاعيد', 'الخطوط الدقيقة', 'شد البشرة', 'مكافحة الشيخوخة'],
  },
  {
    kind: 'concern',
    canonical: 'sensitivity',
    name_en: 'Sensitivity',
    name_ar: 'الحساسية',
    synonyms_en: ['sensitivity', 'sensitive skin', 'redness', 'irritation', 'rosacea'],
    synonyms_ar: ['حساسية', 'بشرة حساسة', 'احمرار', 'تهيج'],
  },
  {
    kind: 'concern',
    canonical: 'hair_loss',
    name_en: 'Hair loss',
    name_ar: 'تساقط الشعر',
    synonyms_en: ['hair loss', 'hair fall', 'shedding', 'thinning', 'baldness', 'alopecia'],
    synonyms_ar: ['تساقط الشعر', 'تساقط', 'خفة الشعر', 'صلع'],
  },
  {
    kind: 'concern',
    canonical: 'dandruff',
    name_en: 'Dandruff',
    name_ar: 'القشرة',
    synonyms_en: ['dandruff', 'flakes', 'itchy scalp', 'seborrheic'],
    synonyms_ar: ['قشرة', 'قشرة الرأس', 'حكة فروة الرأس'],
  },
  {
    kind: 'concern',
    canonical: 'oiliness',
    name_en: 'Oiliness',
    name_ar: 'الدهون',
    synonyms_en: ['oily', 'oiliness', 'greasy', 'shine', 'sebum'],
    synonyms_ar: ['دهنية', 'بشرة دهنية', 'لمعان', 'زيتية'],
  },

  // --- Ingredients ---------------------------------------------------------
  {
    kind: 'ingredient',
    canonical: 'niacinamide',
    name_en: 'Niacinamide',
    name_ar: 'نياسيناميد',
    synonyms_en: ['niacinamide', 'vitamin b3'],
    synonyms_ar: ['نياسيناميد', 'فيتامين ب3'],
  },
  {
    kind: 'ingredient',
    canonical: 'hyaluronic_acid',
    name_en: 'Hyaluronic acid',
    name_ar: 'حمض الهيالورونيك',
    synonyms_en: ['hyaluronic acid', 'ha', 'sodium hyaluronate'],
    synonyms_ar: ['حمض الهيالورونيك', 'هيالورونيك'],
  },
  {
    kind: 'ingredient',
    canonical: 'retinol',
    name_en: 'Retinol',
    name_ar: 'ريتينول',
    synonyms_en: ['retinol', 'retinoid', 'retinal', 'vitamin a'],
    synonyms_ar: ['ريتينول', 'ريتينويد', 'فيتامين أ'],
  },
  {
    kind: 'ingredient',
    canonical: 'salicylic_acid',
    name_en: 'Salicylic acid',
    name_ar: 'حمض الساليسيليك',
    synonyms_en: ['salicylic acid', 'bha'],
    synonyms_ar: ['حمض الساليسيليك', 'ساليسيليك'],
  },
  {
    kind: 'ingredient',
    canonical: 'vitamin_c',
    name_en: 'Vitamin C',
    name_ar: 'فيتامين سي',
    synonyms_en: ['vitamin c', 'ascorbic acid', 'l-ascorbic'],
    synonyms_ar: ['فيتامين سي', 'حمض الأسكوربيك'],
  },

  // --- Brands (phonetic spellings are the point here) ----------------------
  {
    kind: 'brand',
    canonical: 'la_roche_posay',
    name_en: 'La Roche-Posay',
    name_ar: 'لاروش بوزيه',
    synonyms_en: ['la roche-posay', 'la roche posay', 'la roche', 'laroche', 'lrp'],
    synonyms_ar: ['لاروش', 'لاروش بوزيه', 'لا روش'],
  },
  {
    kind: 'brand',
    canonical: 'cerave',
    name_en: 'CeraVe',
    name_ar: 'سيرافي',
    synonyms_en: ['cerave', 'cera ve'],
    synonyms_ar: ['سيرافي', 'سيرا في'],
  },
  {
    kind: 'brand',
    canonical: 'the_ordinary',
    name_en: 'The Ordinary',
    name_ar: 'ذا أوردنري',
    synonyms_en: ['the ordinary', 'ordinary'],
    synonyms_ar: ['ذا أوردنري', 'اوردنري'],
  },
  {
    kind: 'brand',
    canonical: 'bioderma',
    name_en: 'Bioderma',
    name_ar: 'بيوديرما',
    synonyms_en: ['bioderma'],
    synonyms_ar: ['بيوديرما'],
  },
  {
    kind: 'brand',
    canonical: 'vichy',
    name_en: 'Vichy',
    name_ar: 'فيشي',
    synonyms_en: ['vichy'],
    synonyms_ar: ['فيشي', 'فيتشي'],
  },

  // --- Categories ----------------------------------------------------------
  {
    kind: 'category',
    canonical: 'face',
    name_en: 'Face Care',
    name_ar: 'العناية بالوجه',
    synonyms_en: ['face', 'face care', 'skincare', 'skin care', 'facial'],
    synonyms_ar: ['العناية بالوجه', 'وجه', 'بشرة'],
  },
  {
    kind: 'category',
    canonical: 'body',
    name_en: 'Body Care',
    name_ar: 'العناية بالجسم',
    synonyms_en: ['body', 'body care'],
    synonyms_ar: ['العناية بالجسم', 'جسم'],
  },
  {
    kind: 'category',
    canonical: 'hair',
    name_en: 'Hair & Scalp',
    name_ar: 'الشعر وفروة الرأس',
    synonyms_en: ['hair', 'hair care', 'scalp'],
    synonyms_ar: ['الشعر', 'العناية بالشعر', 'فروة الرأس'],
  },
  {
    kind: 'category',
    canonical: 'vitamins',
    name_en: 'Vitamins & Wellness',
    name_ar: 'الفيتامينات والصحة',
    synonyms_en: ['vitamins', 'supplements', 'wellness'],
    synonyms_ar: ['فيتامينات', 'مكملات', 'صحة'],
  },
];
