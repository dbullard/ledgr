import { z } from "zod";

/** Key for the product dictionary: case, spacing and punctuation don't matter. */
export function normalizeRawName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 120);
}

/** What the model is asked to return. Dollars are integer cents. */
export const parsedReceiptSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      quantity: z.number().optional(),
      totalCents: z.number(),
      product: z.string().optional(),
      category: z.string().optional(),
    }),
  ),
  taxCents: z.number().optional(),
  totalCents: z.number().optional(),
  merchant: z.string().optional(),
  /** YYYY-MM-DD */
  date: z.string().optional(),
});
export type ParsedReceipt = z.infer<typeof parsedReceiptSchema>;

/**
 * A receipt already read on the user's own device (Apple's on-device model).
 * Untrusted input: size-capped, validated, and null when it isn't usable.
 */
export function parseClientReceipt(raw: unknown): ParsedReceipt | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200_000) return null;
  try {
    const out = parsedReceiptSchema.safeParse(JSON.parse(raw));
    if (!out.success) return null;
    return { ...out.data, items: out.data.items.slice(0, 300) };
  } catch {
    return null;
  }
}

export interface PricedLine {
  name: string;
  quantity: number;
  totalCents: number;
}

const QTY_AT_END = /\bQty\s+(\d+)\s+\$([\d,]+\.\d{2})\s*$/;
const SECTION_HEADER = /items\s*\(\d+\)\s*$/i;
/** Lines that are never part of a product name: anything with a price, and the summary block. */
const NOT_A_NAME = /\$|^(?:subtotal|total|delivery|shipping|sales|tax|savings|promotion|driver|free)\b/i;

/**
 * Lines printed as "<name> Qty N $price" (Sam's Club and Walmart order pages).
 * The price is the line total. Two text layouts exist and both are read:
 *  - the server's PDF text: single spaces, and a long name wraps with its tail
 *    on the line BEFORE "Qty";
 *  - column text (`pdftotext -layout`): a wide gap before "Qty", and the tail on
 *    the line AFTER.
 * Returns [] for any other layout, so callers fall back to the model.
 */
export function extractPricedLines(text: string | null): PricedLine[] {
  if (!text) return [];
  const layout = /\S {2,}Qty\s+\d+\s+\$/.test(text);
  const lines = text.split("\n").map((l) => l.trimEnd());
  const out: PricedLine[] = [];
  let pending: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(QTY_AT_END);
    if (!m) {
      const t = line.trim();
      if (SECTION_HEADER.test(t)) pending = [];
      else if (t && !NOT_A_NAME.test(t)) pending.push(t);
      continue;
    }
    const head = line.slice(0, m.index).trim();
    let name: string;
    if (head) {
      name = head;
      const next = (lines[i + 1] ?? "").trim();
      if (layout && next && !QTY_AT_END.test(next) && !SECTION_HEADER.test(next) && !NOT_A_NAME.test(next)) {
        name += ` ${next}`;
        i += 1;
      }
    } else {
      // Wrapped name: the pieces are the lines since the last price. A preamble (address) can
      // precede the first item, so a long run keeps only its last two lines.
      name = (pending.length > 3 ? pending.slice(-2) : pending).join(" ");
    }
    pending = [];
    const cents = Math.round(parseFloat(m[2].replace(/,/g, "")) * 100);
    if (name && cents > 0) out.push({ name, quantity: parseInt(m[1], 10), totalCents: cents });
  }
  return out;
}

/**
 * Models sometimes attach a neighbouring line's price, or read a size
 * ("61.81 oz.") as a price. When the receipt text prints priced lines, those
 * prices win: a model item whose name matches a printed line takes that line's
 * price and quantity, and printed lines the model skipped are added.
 */
export function correctPricesFromText(parsed: ParsedReceipt, text: string | null): ParsedReceipt {
  const printed = extractPricedLines(text);
  if (printed.length === 0) return parsed;
  const left = printed.map((p) => ({ p, key: matchKey(p.name) }));
  const take = (name: string): PricedLine | null => {
    const k = matchKey(name);
    if (!k) return null;
    // Exact name first, then one that is a prefix of the other (a model often drops a wrapped tail).
    const at =
      left.findIndex((l) => l.key === k) >= 0
        ? left.findIndex((l) => l.key === k)
        : left.findIndex((l) => k.length >= 20 && (l.key.startsWith(k) || k.startsWith(l.key)));
    return at >= 0 ? left.splice(at, 1)[0].p : null;
  };
  const items = parsed.items.map((it) => {
    const hit = take(it.name);
    return hit ? { ...it, totalCents: hit.totalCents, quantity: hit.quantity } : it;
  });
  for (const { p } of left) items.push({ name: p.name, quantity: p.quantity, totalCents: p.totalCents });
  return { ...parsed, items };
}

/** normalizeRawName, forgiving the capital-I / lowercase-L mix-up in "lbs." that models and OCR make. */
export function matchKey(name: string): string {
  return normalizeRawName(name).replace(/\bibs\b/g, "lbs");
}

const SUMMARY_WORD = /\b(?:sub\s?total|total|tax|tip|gratuity|balance|change|tendered|visa|mastercard|amex|discover|amount|payment|approval|authorization)\b/i;
const PRICE_AT_END = /^(.*?)\s*\$\s*(\d{1,3}(?:,\d{3})*\.\d{2})\s*$/;

/**
 * Restaurant-style receipts (text read from a photo or a printed email): a name,
 * then a "$price" at the end of the line, before the subtotal. Names can wrap
 * (a one-word line like "Sandwich" takes the line above), and modifier lines
 * ("Gluten Free Bun") carry no price and are left out.
 *
 * The printed subtotal is the proof: lines are returned only when they add up to
 * it exactly. Anything else returns [], so a misread receipt gets no items rather
 * than wrong ones.
 */
export function extractTotaledLines(text: string | null): PricedLine[] {
  if (!text) return [];
  const lines = text.split("\n").map((l) => l.trim().replace(/^[‘’'`"“”]+/, ""));
  const end = lines.findIndex((l) => /\bsub\s?total\b/i.test(l) && /\d\.\d{2}/.test(l));
  if (end < 0) return [];
  const subtotal = lines[end].match(/\$?\s*(\d{1,3}(?:,\d{3})*\.\d{2})\s*$/);
  if (!subtotal) return [];
  const subtotalCents = Math.round(parseFloat(subtotal[1].replace(/,/g, "")) * 100);

  const out: PricedLine[] = [];
  let lastName = "";
  for (const line of lines.slice(0, end)) {
    if (!line) continue;
    const m = line.match(PRICE_AT_END);
    if (!m || SUMMARY_WORD.test(line) || /\bfor \$|\bat\b.*\$/i.test(line)) {
      if (!m && !SUMMARY_WORD.test(line) && !/@|\.com\b|\d{3,}/.test(line)) lastName = line;
      continue;
    }
    let name = m[1].trim();
    let quantity = 1;
    const q = name.match(/^(\d{1,2})\s+(.+)$/);
    if (q) {
      quantity = parseInt(q[1], 10);
      name = q[2];
    }
    if (name && name.split(/\s+/).length <= 1 && lastName) name = `${lastName} ${name}`;
    const cents = Math.round(parseFloat(m[2].replace(/,/g, "")) * 100);
    if (name && cents > 0) out.push({ name, quantity, totalCents: cents });
    lastName = "";
  }
  return out.reduce((s, l) => s + l.totalCents, 0) === subtotalCents ? out : [];
}

/** "Red Baron Pepperoni Pizza, 61.81 oz., 3 pk." -> "Red Baron Pepperoni Pizza". */
export function cleanProductName(name: string): string {
  return name
    .replace(/\u2019/g, "'")
    .replace(/,?\s*priced per pound.*$/i, "")
    .replace(/[,\s]+\d[\d.]*\s*(?:oz|fl|lb|lbs|ct|pk|gal|dozen|rolls|wipes|sheets|tissues)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .slice(0, 120);
}

const CATEGORY_RULES: [RegExp, string][] = [
  [/diaper|baby wipes|infant formula/i, "Baby"],
  [/probiotic|creatine|vitamin(?! d whole)/i, "Pharmacy"],
  [/\bpads\b|razor|shampoo|toothpaste|deodorant/i, "Personal Care"],
  [/toilet paper|facial tissues|paper towel|trash bag|detergent|gas grill|griddle|cookware/i, "Home Goods"],
];

/**
 * A category NAME for a store-order line. Only used where lines are read without
 * a model; names the household doesn't have are dropped when stored, and the
 * household's own corrections override this. Everything else on a grocery order is food.
 */
export function guessCategoryName(name: string): string {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(name)) return cat;
  return "Groceries";
}

/**
 * The items for a newly stored receipt, with no model needed. A reader on the
 * user's device may already have items: its prices are checked against the
 * printed lines. Otherwise printed `Qty N $price` lines become the items.
 */
export function itemsFromText(
  text: string | null,
  onDevice: ParsedReceipt | null,
  /** Category name for lines that aren't store-order lines (e.g. the transaction's own category). */
  defaultCategory?: string | null,
): ParsedReceipt["items"] {
  if (onDevice && onDevice.items.length > 0) return correctPricesFromText(onDevice, text).items;
  const store = extractPricedLines(text);
  if (store.length > 0) {
    return store.map((l) => ({
      name: l.name,
      quantity: l.quantity,
      totalCents: l.totalCents,
      product: cleanProductName(l.name),
      category: guessCategoryName(l.name),
    }));
  }
  return extractTotaledLines(text).map((l) => ({
    name: l.name,
    quantity: l.quantity,
    totalCents: l.totalCents,
    product: l.name,
    ...(defaultCategory ? { category: defaultCategory } : {}),
  }));
}

export interface CategoryOption {
  id: string;
  name: string;
}

export interface CleanItem {
  rawName: string;
  productName: string | null;
  categoryId: string | null;
  quantityMilli: number;
  totalCents: number;
}

/**
 * Receipt summary lines the extractor sometimes returns as if they were
 * purchases ("Total", "Change", "Driver tip", ...). Matched against the whole
 * name so a product that merely contains one of these words is kept.
 */
const SUMMARY_LINE =
  /^(?:(?:sub[\s-]*)?total(?:\s+(?:due|amount|savings|purchase))?|(?:sales\s+)?tax(?:\s+\d.*)?|change(?:\s+due)?|balance(?:\s+due)?|amount\s+(?:due|paid|tendered)|(?:driver|delivery|service)?\s*tip|(?:total\s+)?savings|cash|tend(?:er(?:ed)?)?|(?:visa|mastercard|debit|credit)(?:\s+(?:card|tend))?|items?\s+sold|number\s+of\s+items)[\s:.\-]*$/i;

export function isSummaryLine(name: string): boolean {
  return SUMMARY_LINE.test(name.replace(/\s+/g, " ").trim());
}

/**
 * Drops lines that can't be real purchases (no name, summary lines, zero or absurd price),
 * snaps categories to ones the household actually has, and converts quantity.
 * Negative lines (discounts, coupons) are kept: they reduce the total.
 */
export function cleanItems(parsed: ParsedReceipt, categories: CategoryOption[]): CleanItem[] {
  const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
  const out: CleanItem[] = [];
  for (const it of parsed.items) {
    const rawName = it.name.replace(/\s+/g, " ").trim().slice(0, 200);
    const cents = Math.round(it.totalCents);
    if (!rawName || !Number.isFinite(cents) || cents === 0 || Math.abs(cents) > 10_000_000) continue;
    if (isSummaryLine(rawName)) continue;
    const qty = it.quantity && Number.isFinite(it.quantity) && it.quantity > 0 ? it.quantity : 1;
    out.push({
      rawName,
      productName: it.product?.trim().slice(0, 120) || null,
      categoryId: it.category ? (byName.get(it.category.trim().toLowerCase()) ?? null) : null,
      quantityMilli: Math.min(Math.round(qty * 1000), 1_000_000),
      totalCents: cents,
    });
  }
  return out;
}

export interface Alias {
  rawKey: string;
  productName: string | null;
  categoryId: string | null;
}

/** The household's confirmed dictionary overrides whatever the model guessed. */
export function applyAliases(items: CleanItem[], aliases: Alias[]): CleanItem[] {
  const byKey = new Map(aliases.map((a) => [a.rawKey, a]));
  return items.map((it) => {
    const a = byKey.get(normalizeRawName(it.rawName));
    if (!a) return it;
    return {
      ...it,
      productName: a.productName ?? it.productName,
      categoryId: a.categoryId ?? it.categoryId,
    };
  });
}

/** Sum of lines and how far it is from the receipt's own total (tax etc. explain a positive gap). */
export function reconcile(items: { totalCents: number }[], receiptTotalCents: number | null) {
  const itemsTotalCents = items.reduce((s, i) => s + i.totalCents, 0);
  return {
    itemsTotalCents,
    gapCents: receiptTotalCents === null ? null : receiptTotalCents - itemsTotalCents,
  };
}

/**
 * Turns categorized item totals into split amounts that add up to exactly the
 * transaction amount. Tax, fees and uncategorized lines are spread across the
 * categories in proportion to their item totals (largest remainder, so no cent
 * is lost). Returns null when no item has a category.
 */
export function allocateSplits(
  items: { categoryId: string | null; totalCents: number }[],
  transactionCents: number,
): { categoryId: string; amount: number }[] | null {
  const weights = new Map<string, number>();
  for (const it of items) {
    if (it.categoryId && it.totalCents > 0) {
      weights.set(it.categoryId, (weights.get(it.categoryId) ?? 0) + it.totalCents);
    }
  }
  const sum = [...weights.values()].reduce((a, b) => a + b, 0);
  if (sum === 0 || transactionCents <= 0) return null;

  const shares = [...weights].map(([categoryId, w]) => {
    const exact = (transactionCents * w) / sum;
    return { categoryId, amount: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let leftover = transactionCents - shares.reduce((s, x) => s + x.amount, 0);
  for (const s of [...shares].sort((a, b) => b.frac - a.frac)) {
    if (leftover <= 0) break;
    s.amount += 1;
    leftover -= 1;
  }
  return shares.filter((s) => s.amount > 0).map(({ categoryId, amount }) => ({ categoryId, amount }));
}

export function buildItemsPrompt(text: string | null, categoryNames: string[]): string {
  return [
    "Extract the purchased line items from this receipt.",
    "Rules:",
    "- One entry per purchased product. Skip subtotal, tax, total, tender, change, loyalty and savings summary lines.",
    '- name: copy the item text EXACTLY as printed on the receipt, character for character (keep abbreviations and capital letters; never expand, translate or reword it).',
    "- totalCents is the line's price in integer cents (a $3.49 line is 349). Discount or coupon lines are negative.",
    '- The price is the dollar amount printed on that same line (after "Qty"). Never use a size or weight from the name, such as "61.81 oz.", and never a price from the line above or below.',
    "- quantity is the count or weight when printed, else 1.",
    '- product: always fill this with a short plain-English name for the item (e.g. name "KS ORG BNNA" -> product "Bananas").',
    ...(categoryNames.length
      ? [`- category must be exactly one of: ${categoryNames.join(", ")}. Omit it if none fits.`]
      : []),
    "- taxCents and totalCents are the receipt's printed tax and grand total, if present.",
    "- merchant is the store name and date is the purchase date as YYYY-MM-DD, if present.",
    ...(text ? ["", "Receipt text:", text.slice(0, 12_000)] : ["", "The receipt is the attached image."]),
  ].join("\n");
}
