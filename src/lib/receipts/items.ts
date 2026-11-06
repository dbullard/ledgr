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
 * Drops lines that can't be real purchases (no name, zero or absurd price),
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
    "- totalCents is the line's price in integer cents (a $3.49 line is 349). Discount or coupon lines are negative.",
    "- quantity is the count or weight when printed, else 1.",
    '- product is a short plain-English name for the item (e.g. "KS ORG BNNA" -> "Bananas").',
    ...(categoryNames.length
      ? [`- category must be exactly one of: ${categoryNames.join(", ")}. Omit it if none fits.`]
      : []),
    "- taxCents and totalCents are the receipt's printed tax and grand total, if present.",
    "- merchant is the store name and date is the purchase date as YYYY-MM-DD, if present.",
    ...(text ? ["", "Receipt text:", text.slice(0, 12_000)] : ["", "The receipt is the attached image."]),
  ].join("\n");
}
