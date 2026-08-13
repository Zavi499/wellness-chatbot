/**
 * Shared domain types. These mirror the `_wwc_*` meta schema in spec §3.2 and
 * the JSON contracts in §4.1, §4.7 and §10 — the widget, the plugin and this
 * service all speak the same shapes.
 */

export type Language = 'en' | 'ar';

export type VerificationStatus =
  | 'verified'
  | 'partial'
  | 'unverified'
  | 'needs_pharmacist_review';

export type CategoryKey = 'face' | 'body' | 'hair' | 'vitamins' | 'routine' | 'compare';

export type TriState = 'yes' | 'no' | 'unspecified';

export type AgeSuitability = 'adult' | 'teen' | 'child' | 'infant' | 'all';

/** Bilingual string pair. `ar` may be null until a human translator fills it. */
export interface Bilingual {
  en: string | null;
  ar: string | null;
}

export interface BilingualList {
  en: string[];
  ar: string[];
}

/**
 * A product as this service stores it: WooCommerce natives plus the `_wwc_*`
 * extension fields.
 */
export interface Product {
  product_id: number;
  sku: string | null;
  name: string;
  name_ar: string | null;
  permalink: string | null;
  image_url: string | null;
  short_description: string | null;
  description: string | null;
  categories: string[];
  tags: string[];
  brand: string | null;
  price: number | null;
  regular_price: number | null;
  sale_price: number | null;
  currency: string;
  size: string | null;
  stock_status: 'instock' | 'outofstock' | 'onbackorder';
  rating_average: number | null;
  rating_count: number;

  // --- _wwc_* extension schema (spec §3.2) ---------------------------------
  verification_status: VerificationStatus;
  ai_generated: boolean;
  ai_confidence: number | null;
  requires_pharmacist_review: boolean;
  verified_by_pharmacist: boolean;

  concern_primary: BilingualList;
  concern_secondary: BilingualList;
  suitable_types: BilingualList;
  not_ideal_for: Bilingual;
  key_ingredients: string[];
  full_ingredients: string | null;
  texture_finish: Bilingual;
  fragrance: TriState;
  fragrance_type: string | null;
  alcohol: TriState;
  alcohol_type: string | null;
  how_to_use: Bilingual;
  routine_step: string | null;
  routine_time: 'am' | 'pm' | 'both' | null;
  age_suitability: AgeSuitability;
  age_min: number | null;
  age_max: number | null;
  pregnancy_guidance: Bilingual | 'refer_to_pharmacist' | null;
  warnings: Bilingual;
  complementary_products: number[];
  alternative_products: number[];
  source_verification_date: string | null;
  source_verification_note: string | null;
  synonyms_en: string[];
  synonyms_ar: string[];

  updated_at: string;
}

/** The customer's collected questionnaire answers (spec §4.1). */
export type AnswerMap = Record<string, string | string[]>;

export interface EscalationState {
  triggered: boolean;
  reason: string | null;
  urgency: EscalationUrgency | null;
  /** Once an emergency fires, selling stops for the rest of the session (§5.1). */
  selling_blocked: boolean;
}

export type EscalationUrgency = 'emergency' | 'pharmacist_review';

export interface SessionState {
  session_id: string;
  language: Language | null;
  language_locked: boolean;
  created_at: string;
  last_active_at: string;
  answers: AnswerMap;
  escalation: EscalationState;
  last_recommendations: number[];
  /** Turn-by-turn history handed back to the model each call. */
  history: ChatTurn[];
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

// --- Widget response contract (spec §4.7, §10) ------------------------------

export interface QuickReply {
  label: string;
  value: string;
}

export interface RecommendationItem {
  product_id: number;
  label: string;
  name: string;
  image_url: string | null;
  permalink: string | null;
  price: string | null;
  size: string | null;
  in_stock: boolean;
  why_it_suits_you: string[];
  best_for: string;
  what_to_know: string;
  how_to_use: string;
  actions: string[];
  /** Internal-only, stripped before the widget sees it if `debug` is off. */
  score?: number;
  score_breakdown?: Record<string, number>;
}

export interface RecommendationSet {
  type: 'recommendation_set';
  items: RecommendationItem[];
  disclaimer: string;
  /** Set when fewer than three eligible products existed (§4.6). */
  shortfall_note?: string;
}

export interface RoutinePlan {
  type: 'routine_plan';
  am: { step: string; product_id: number; name: string }[];
  pm: { step: string; product_id: number; name: string }[];
  note: string;
}

export interface ChatResponse {
  session_id: string;
  message: string;
  language: Language;
  quick_replies: QuickReply[];
  recommendations?: RecommendationSet;
  routine?: RoutinePlan;
  escalation?: {
    urgency: EscalationUrgency;
    reason: string;
    handoff: HandoffOptions;
  };
  progress?: { step: number; total: number };
  message_id: string;
  /** True when selling has been switched off for the rest of the session. */
  selling_blocked: boolean;
}

export interface HandoffOptions {
  whatsapp_url: string | null;
  phone: string | null;
  live_chat_note: string | null;
  hours: string | null;
}

/** Business facts owned by the WP Business Settings screen (spec §8.5). */
export interface BusinessSettings {
  delivery_areas: string | null;
  delivery_fee: string | null;
  free_delivery_threshold: string | null;
  order_cutoff_time: string | null;
  service_hours: string | null;
  whatsapp_number: string | null;
  phone_number: string | null;
  live_chat_note: string | null;
  payment_methods: string | null;
  loyalty_rules: string | null;
  returns_policy: string | null;
  currency: string;
}

export interface KbEntry {
  id: number;
  topic: string;
  question_en: string | null;
  question_ar: string | null;
  answer_en: string | null;
  answer_ar: string | null;
  approved: boolean;
  updated_at: string;
  updated_by: string | null;
}
