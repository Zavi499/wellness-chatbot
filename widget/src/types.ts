/** Shapes shared with the backend (mirrors backend/src/types.ts). */

export type Language = 'en' | 'ar';

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
}

export interface RecommendationSet {
  type: 'recommendation_set';
  items: RecommendationItem[];
  disclaimer: string;
  shortfall_note?: string;
}

export interface ChatResponse {
  session_id: string;
  message: string;
  language: Language;
  quick_replies: QuickReply[];
  recommendations?: RecommendationSet;
  progress?: { step: number; total: number };
  message_id: string;
}

export interface SessionResponse {
  session_id: string;
  token: string;
  language: Language;
  greeting: string;
  privacy_notice: string;
}

/**
 * Widget chrome labels, supplied by the plugin so they go through WordPress
 * translation. Declared as required keys rather than an index signature so a
 * missing label is a compile error, not an "undefined" in the UI.
 */
export interface Strings {
  launcher: string;
  title: string;
  placeholder: string;
  send: string;
  close: string;
  open: string;
  thinking: string;
  why: string;
  compare: string;
  replace: string;
  addToCart: string;
  viewProduct: string;
  outOfStock: string;
  inStock: string;
  helpful: string;
  yes: string;
  no: string;
  feedbackReason: string;
  back: string;
  stepOf: string;
  error: string;
  privacy: string;
  compareTitle: string;
  bestFor: string;
  whatToKnow: string;
  howToUse: string;
  price: string;
  size: string;
}

export interface WidgetConfig {
  restUrl: string;
  addToCartUrl: string;
  ajaxUrl: string;
  isRtl: boolean;
  locale: string;
  strings: Record<Language, Strings>;
}

declare global {
  interface Window {
    WWC_CONFIG?: WidgetConfig;
  }
}
