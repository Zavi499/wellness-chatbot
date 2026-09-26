/**
 * Types for the skin/hair analyzer pages. Kept beside the chat widget's own
 * types rather than merged into them: the two front-ends share the product
 * card vocabulary and nothing else.
 */
import type { CardStrings, Language, QuickReply, RecommendationSet } from './types.js';

export type AnalyzerKind = 'skin' | 'hair';

export interface AnalyzerQuestion {
  key: string;
  text: string;
  type: 'single' | 'multi';
  options: QuickReply[];
}

export interface AnalyzerProgress {
  step: number;
  total: number;
}

/** What every step endpoint returns — one shape for the wizard to render. */
export interface AnalyzerStep {
  done: boolean;
  question?: AnalyzerQuestion;
  progress: AnalyzerProgress;
  recommendations?: RecommendationSet;
}

export interface AnalyzerSession extends AnalyzerStep {
  session_id: string;
  token: string;
  kind: AnalyzerKind;
  language: Language;
  privacy_notice: string;
}

export interface PhotoResult extends AnalyzerStep {
  usable: boolean;
  unusable_reason: string | null;
  refer_to_professional: boolean;
  referral_note: string | null;
  summary: string | null;
  prefilled: string[];
}

/** Labels the analyzer page needs on top of the shared card ones. */
export interface AnalyzerStrings extends CardStrings {
  skinTitle: string;
  skinIntro: string;
  hairTitle: string;
  hairIntro: string;
  photoPrompt: string;
  photoHint: string;
  photoPrivacy: string;
  choosePhoto: string;
  retakePhoto: string;
  analyzing: string;
  skipPhoto: string;
  photoUnusable: string;
  whatISaw: string;
  prefilledNote: string;
  start: string;
  back: string;
  next: string;
  stepOf: string;
  resultsTitle: string;
  startOver: string;
  error: string;
  tooLarge: string;
  notAnImage: string;
}

export interface AnalyzerConfig {
  restUrl: string;
  addToCartUrl: string;
  isRtl: boolean;
  language: Language;
  strings: Record<Language, AnalyzerStrings>;
}

declare global {
  interface Window {
    WWC_ANALYZER_CONFIG?: AnalyzerConfig;
  }
}
