/**
 * Suggests a category for a transaction from the household's own past manual
 * choices: if "CASEYS #4471" was filed under Gas every time before, a new
 * "CASEYS #9120" probably is too. Pure and offline: no model, no network.
 *
 * It only ever answers when the evidence is strong (enough examples, and a
 * clear majority); otherwise it returns null and leaves the row for the other
 * tiers or a human.
 */

/** Fewest past examples before we'll offer a suggestion. */
export const MIN_SUPPORT = 2;
/** Share of past examples the winning category needs. */
export const MIN_SHARE = 0.8;
/** Shortest rule pattern we'll propose; shorter ones match too much. */
const MIN_PATTERN_LENGTH = 4;

/** Payment-processor prefixes banks glue onto the merchant ("SQ *", "TST*", "PAYPAL *"). */
const PROCESSOR_PREFIX = /^(?:sq|tst|sp|pp|paypal|pos|dd)\s*\*\s*/i;

/**
 * Reduces a bank description to the part that identifies the merchant:
 * lowercase words only, with processor prefixes, store numbers, ids and
 * punctuation removed.
 */
export function normalizeDescriptor(name: string): string {
  return name
    .replace(PROCESSOR_PREFIX, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 0 && !/\d/.test(token))
    .join(" ");
}

export interface HistoryExample {
  name: string;
  categoryId: string;
}

/** descriptor -> (categoryId -> number of past examples). */
export type HistoryIndex = Map<string, Map<string, number>>;

export function buildHistoryIndex(examples: Iterable<HistoryExample>): HistoryIndex {
  const index: HistoryIndex = new Map();
  for (const { name, categoryId } of examples) {
    const key = normalizeDescriptor(name);
    if (!key) continue;
    let counts = index.get(key);
    if (!counts) {
      counts = new Map();
      index.set(key, counts);
    }
    counts.set(categoryId, (counts.get(categoryId) ?? 0) + 1);
  }
  return index;
}

export interface HistorySuggestion {
  categoryId: string;
  /** 0..1; grows with the number of agreeing examples and their share. */
  confidence: number;
  /** Past examples that agree with the suggestion. */
  support: number;
  /** All past examples for this merchant, whatever category. */
  total: number;
}

export function suggestFromHistory(name: string, index: HistoryIndex): HistorySuggestion | null {
  const key = normalizeDescriptor(name);
  if (!key) return null;
  const counts = index.get(key);
  if (!counts) return null;

  let total = 0;
  let bestId = "";
  let best = 0;
  for (const [categoryId, count] of counts) {
    total += count;
    if (count > best) {
      best = count;
      bestId = categoryId;
    }
  }

  const share = best / total;
  if (best < MIN_SUPPORT || share < MIN_SHARE) return null;
  return {
    categoryId: bestId,
    confidence: share * (1 - 1 / (best + 2)),
    support: best,
    total,
  };
}

/**
 * The text to offer as a category rule's match pattern: the leading words of
 * the description, before any store number or symbol. Returns null when
 * nothing safe is left, because the engine matches rules by substring and a
 * short pattern would hit unrelated merchants.
 */
export function suggestRulePattern(name: string): string | null {
  const stripped = name.replace(PROCESSOR_PREFIX, "").trim();
  const lead = /^[A-Za-z][A-Za-z'&.\- ]*/.exec(stripped)?.[0].trim() ?? "";
  return lead.length >= MIN_PATTERN_LENGTH ? lead : null;
}
