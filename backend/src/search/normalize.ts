/**
 * Query normalization (spec §6.3).
 *
 * Handles the three things that break naive matching on a bilingual Kuwaiti
 * store: Arabic orthography variants (أ/إ/آ → ا, ة → ه, tashkeel, tatweel),
 * Arabic-Indic digits, and EN/AR synonym expansion via the lexicon.
 */
import { LEXICON_SEED, type LexiconEntry } from './lexicon.js';

const ARABIC_DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;
const ARABIC_INDIC = /[٠-٩۰-۹]/g;

/** Normalizes Arabic orthography so "واقى الشمس" and "واقي الشمس" match. */
export function normalizeArabic(input: string): string {
  return input
    .replace(ARABIC_DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(/[آأإٱ]/g, 'ا') // آ أ إ ٱ → ا
    .replace(/ى/g, 'ي') // ى → ي
    .replace(/ة/g, 'ه') // ة → ه
    .replace(/ؤ/g, 'و') // ؤ → و
    .replace(/ئ/g, 'ي'); // ئ → ي
}

export function normalizeDigits(input: string): string {
  return input.replace(ARABIC_INDIC, (d) => {
    const code = d.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/** The single entry point: lowercase, strip punctuation, fold Arabic forms. */
export function normalizeQuery(input: string): string {
  return normalizeArabic(normalizeDigits(input))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s+]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface NormalizedQuery {
  original: string;
  normalized: string;
  /** Canonical lexicon keys the query hit, e.g. ['sunscreen', 'sensitivity']. */
  concepts: string[];
  /** The normalized query plus every matched synonym, for keyword scoring. */
  expanded: string[];
}

let cachedIndex: { term: string; entry: LexiconEntry }[] | null = null;

function lexiconIndex(extra: LexiconEntry[] = []): { term: string; entry: LexiconEntry }[] {
  if (!cachedIndex || extra.length > 0) {
    const index: { term: string; entry: LexiconEntry }[] = [];
    for (const entry of [...LEXICON_SEED, ...extra]) {
      const terms = new Set([
        entry.name_en,
        entry.name_ar,
        ...entry.synonyms_en,
        ...entry.synonyms_ar,
      ]);
      for (const t of terms) {
        if (!t) continue;
        index.push({ term: normalizeQuery(t), entry });
      }
    }
    // Longest term first so "face wash" wins over "face".
    index.sort((a, b) => b.term.length - a.term.length);
    if (extra.length === 0) cachedIndex = index;
    else return index;
  }
  return cachedIndex;
}

/**
 * Expands a raw customer query into canonical concepts plus synonym terms.
 * Deliberately conservative — it never rewrites the query the model sees, it
 * only adds retrieval signal alongside embeddings.
 */
export function expandQuery(raw: string, extraLexicon: LexiconEntry[] = []): NormalizedQuery {
  const normalized = normalizeQuery(raw);
  const concepts = new Set<string>();
  const expanded = new Set<string>([normalized]);

  for (const { term, entry } of lexiconIndex(extraLexicon)) {
    if (term && normalized.includes(term)) {
      concepts.add(entry.canonical);
      for (const s of [...entry.synonyms_en, ...entry.synonyms_ar, entry.name_en, entry.name_ar]) {
        if (s) expanded.add(normalizeQuery(s));
      }
    }
  }

  return {
    original: raw,
    normalized,
    concepts: [...concepts],
    expanded: [...expanded].filter(Boolean),
  };
}

/** Token overlap score in [0,1]; the keyword half of hybrid retrieval. */
export function keywordScore(query: NormalizedQuery, text: string): number {
  const target = normalizeQuery(text);
  if (!target) return 0;
  const tokens = new Set(query.normalized.split(' ').filter((t) => t.length > 2));
  if (tokens.size === 0) return 0;

  let hits = 0;
  for (const token of tokens) if (target.includes(token)) hits += 1;
  let score = hits / tokens.size;

  // A full synonym phrase match is stronger evidence than scattered tokens.
  for (const phrase of query.expanded) {
    if (phrase.length > 3 && target.includes(phrase)) {
      score = Math.max(score, 0.9);
      break;
    }
  }
  return Math.min(1, score);
}
