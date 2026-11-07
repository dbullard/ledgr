/**
 * Where an item was bought, for display and search. Bank descriptions are noisy
 * ("Sams Club.com DDA PIN POS PUR CD1322 Bentonville"), so known stores get a
 * fixed name and everything else is trimmed at the first bank-statement noise.
 */
interface KnownStore {
  label: string;
  match: RegExp;
  /** Plain-text spellings a search should also hit (matched against normalized text). */
  alts: string[];
}

const KNOWN_STORES: KnownStore[] = [
  { label: "Sam's Club", match: /\bsams?\s?club\b|\bsamsclub\b/i, alts: ["sams club", "samsclub"] },
  { label: "Walmart", match: /\bwalmart\b|\bwm\s+supercenter\b|\bwal-mart\b/i, alts: ["walmart", "wm supercenter"] },
];

const NOISE = /\s+(?:dda|pin|pos|pur|debit|recur|ach|purchase)\b.*$|\s+#.*$|\s+cd\d{4}\b.*$|\s+x{3,}.*$/i;

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/'S\b/g, "'s");
}

export function storeLabel(transactionName: string, merchantName?: string | null): string {
  const known = KNOWN_STORES.find((s) => s.match.test(merchantName ?? "") || s.match.test(transactionName));
  if (known) return known.label;
  if (merchantName?.trim()) return merchantName.trim();
  const cleaned = transactionName.replace(NOISE, "").trim();
  return cleaned ? titleCase(cleaned) : transactionName.trim();
}

/** Lowercase, letters/digits/dots only, so "Sam's Club" and "$11.98" match their stored forms. */
export function searchNormalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9.\s]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One search word becomes the spellings it may appear as: itself, plus the
 * alternates of any known store whose name contains it ("walmart" also finds
 * "WM Supercenter").
 */
export function expandToken(token: string): string[] {
  const t = searchNormalize(token);
  if (!t) return [];
  const out = new Set([t]);
  if (t.length >= 3) {
    for (const s of KNOWN_STORES) {
      if (searchNormalize(s.label).includes(t) || s.alts.some((a) => a.includes(t))) s.alts.forEach((a) => out.add(a));
    }
  }
  return [...out];
}

export function searchTokens(query: string | null | undefined): string[][] {
  return (query ?? "")
    .split(/\s+/)
    .slice(0, 8)
    .map(expandToken)
    .filter((alts) => alts.length > 0);
}
