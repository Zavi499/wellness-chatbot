/**
 * Does a product's label say what the customer asked for?
 *
 * Plain substring matching misses the obvious: a customer asks about
 * "dryness", the product is labelled "dry skin", and neither string contains
 * the other. This widens the customer's term through the bilingual lexicon
 * first ("dryness" → dry skin, dehydrated, flaky, جفاف …) and then compares.
 * It never widens the *product's* labels, so a product still has to actually
 * say the thing — it just doesn't have to say it in the same words.
 */
import { expandQuery, normalizeQuery } from '../search/normalize.js';

/** Fragments shorter than this match far too much ("dry" is fine; "ha" is not). */
const MIN_FRAGMENT = 3;

const variantCache = new Map<string, string[]>();

/** The customer's term plus every lexicon synonym of any concept it names. */
export function termVariants(term: string): string[] {
  const key = term.toLowerCase();
  const cached = variantCache.get(key);
  if (cached) return cached;

  const base = normalizeQuery(term.replace(/_/g, ' '));
  const variants = new Set<string>(base ? [base] : []);
  if (base) {
    for (const v of expandQuery(base).expanded) {
      if (v.length >= MIN_FRAGMENT) variants.add(v);
    }
  }
  const result = [...variants];
  variantCache.set(key, result);
  return result;
}

/**
 * True when any label in `labels` and the customer's `term` (or one of its
 * synonyms) contain one another.
 */
export function labelMatches(labels: (string | null | undefined)[], term: string | null | undefined): boolean {
  if (!term) return false;
  const variants = termVariants(term);
  if (variants.length === 0) return false;
  for (const raw of labels) {
    if (!raw) continue;
    const label = normalizeQuery(raw.replace(/_/g, ' '));
    if (label.length < MIN_FRAGMENT) continue;
    for (const v of variants) {
      if (label.includes(v) || v.includes(label)) return true;
    }
  }
  return false;
}
