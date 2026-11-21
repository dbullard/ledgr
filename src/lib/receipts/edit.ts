import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import type { LedgrDb } from "@/db";
import { categories, productAliases, receiptItems, receipts, transactions } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { normalizeRawName, reconcile } from "./items";

export const MAX_EDIT_ITEMS = 200;

export interface ReceiptEditItem {
  id?: string;
  rawName: string;
  productName?: string | null;
  categoryId?: string | null;
  quantityMilli: number;
  totalCents: number;
}

/** A field left undefined is unchanged; null clears it. */
export interface ReceiptEditInput {
  totalCents?: number | null;
  date?: string | null;
  merchant?: string | null;
  items: ReceiptEditItem[];
}

export interface ReceiptEditData {
  receiptId: string;
  transactionId: string | null;
  totalCents: number | null;
  date: string | null;
  merchant: string | null;
  items: (ReceiptEditItem & { id: string; lineNo: number; categoryName: string | null })[];
  itemsTotalCents: number;
  gapCents: number | null;
}

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const cents = z.number().int().min(-1_000_000_000).max(1_000_000_000);

const itemSchema = z.object({
  id: z.string().min(1).optional(),
  rawName: z.string().trim().min(1, "Every line needs a name").max(255),
  productName: z.string().trim().min(1).max(120).nullable().optional(),
  categoryId: z.string().min(1).nullable().optional(),
  quantityMilli: z.number().int().min(1, "Quantity must be more than zero").max(1_000_000_000),
  totalCents: cents,
});

export const receiptEditSchema = z
  .object({
    totalCents: cents.min(0, "Total can't be negative").nullable().optional(),
    date: z
      .string()
      .refine(isRealDate, "Date must be a real date (YYYY-MM-DD)")
      .nullable()
      .optional(),
    merchant: z
      .string()
      .trim()
      .max(80)
      .nullable()
      .optional()
      .transform((m) => (m === "" ? null : m)),
    items: z.array(itemSchema).max(MAX_EDIT_ITEMS, `A receipt can have at most ${MAX_EDIT_ITEMS} lines`),
  })
  .superRefine((v, ctx) => {
    const ids = v.items.map((i) => i.id).filter((id): id is string => !!id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "The same line was sent twice" });
  });

export async function loadReceiptEditData(
  tx: LedgrDb,
  householdId: string,
  receiptId: string,
): Promise<ReceiptEditData | null> {
  const scoped = scopedQuery(householdId, tx);
  const [receipt] = await tx
    .select({
      id: receipts.id,
      transactionId: receipts.transactionId,
      hintTotalCents: receipts.hintTotalCents,
      hintDate: receipts.hintDate,
      hintMerchant: receipts.hintMerchant,
      txnAmount: transactions.normalizedAmount,
    })
    .from(receipts)
    .leftJoin(transactions, eq(receipts.transactionId, transactions.id))
    .where(scoped.where(receipts, eq(receipts.id, receiptId)))
    .limit(1);
  if (!receipt) return null;

  const items = await tx
    .select({
      id: receiptItems.id,
      lineNo: receiptItems.lineNo,
      rawName: receiptItems.rawName,
      productName: receiptItems.productName,
      categoryId: receiptItems.categoryId,
      categoryName: categories.name,
      quantityMilli: receiptItems.quantityMilli,
      totalCents: receiptItems.totalCents,
    })
    .from(receiptItems)
    .leftJoin(categories, eq(receiptItems.categoryId, categories.id))
    .where(scoped.where(receiptItems, eq(receiptItems.receiptId, receiptId)))
    .orderBy(asc(receiptItems.lineNo));

  const expected = receipt.hintTotalCents ?? (receipt.txnAmount !== null ? Math.abs(receipt.txnAmount) : null);
  return {
    receiptId: receipt.id,
    transactionId: receipt.transactionId,
    totalCents: receipt.hintTotalCents,
    date: receipt.hintDate,
    merchant: receipt.hintMerchant,
    items,
    ...reconcile(items, expected),
  };
}

/**
 * Applies a person's corrections to a receipt: its total, date, merchant and
 * lines. Values are written as entered (no learned-dictionary override). Only
 * a changed product name or category on an existing line teaches the
 * dictionary. Never touches transactionId or autoMatchBlocked. Every check
 * runs before the first write; `tx` must be inside withHousehold, so a
 * thrown error rolls the whole save back.
 */
export async function applyReceiptEdits(
  tx: LedgrDb,
  householdId: string,
  receiptId: string,
  edits: ReceiptEditInput,
): Promise<{ success: true } | { error: string }> {
  const scoped = scopedQuery(householdId, tx);
  const [receipt] = await tx
    .select({ id: receipts.id })
    .from(receipts)
    .where(scoped.where(receipts, eq(receipts.id, receiptId)))
    .limit(1);
  if (!receipt) return { error: "Receipt not found" };

  const existing = await tx
    .select()
    .from(receiptItems)
    .where(scoped.where(receiptItems, eq(receiptItems.receiptId, receiptId)));
  const existingById = new Map(existing.map((e) => [e.id, e]));
  for (const it of edits.items) {
    if (it.id && !existingById.has(it.id)) return { error: "A line on this form no longer exists. Reopen the receipt and try again." };
  }

  const categoryIds = [...new Set(edits.items.map((i) => i.categoryId).filter((c): c is string => !!c))];
  if (categoryIds.length > 0) {
    const found = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(scoped.where(categories, inArray(categories.id, categoryIds)));
    if (found.length !== categoryIds.length) return { error: "Category not found" };
  }

  const hints: Partial<{ hintTotalCents: number | null; hintDate: string | null; hintMerchant: string | null }> = {};
  if (edits.totalCents !== undefined) hints.hintTotalCents = edits.totalCents;
  if (edits.date !== undefined) hints.hintDate = edits.date;
  if (edits.merchant !== undefined) hints.hintMerchant = edits.merchant;

  const keep = new Set(edits.items.map((i) => i.id).filter((id): id is string => !!id));
  const removed = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (removed.length > 0) {
    await tx.delete(receiptItems).where(scoped.where(receiptItems, inArray(receiptItems.id, removed)));
  }

  for (const [i, it] of edits.items.entries()) {
    const lineNo = i + 1;
    const before = it.id ? existingById.get(it.id) : undefined;
    if (!before) {
      await tx.insert(receiptItems).values({
        id: uuid(),
        householdId,
        receiptId,
        lineNo,
        rawName: it.rawName,
        productName: it.productName ?? null,
        categoryId: it.categoryId ?? null,
        quantityMilli: it.quantityMilli,
        totalCents: it.totalCents,
      });
      continue;
    }
    const productName = it.productName !== undefined ? it.productName : before.productName;
    const categoryId = it.categoryId !== undefined ? it.categoryId : before.categoryId;
    await tx
      .update(receiptItems)
      .set({ lineNo, rawName: it.rawName, productName, categoryId, quantityMilli: it.quantityMilli, totalCents: it.totalCents })
      .where(scoped.where(receiptItems, eq(receiptItems.id, before.id)));
    if (productName !== before.productName || categoryId !== before.categoryId) {
      await tx
        .insert(productAliases)
        .values({ id: uuid(), householdId, rawKey: normalizeRawName(before.rawName), productName, categoryId })
        .onConflictDoUpdate({
          target: [productAliases.householdId, productAliases.rawKey],
          set: { productName, categoryId, updatedAt: new Date() },
        });
    }
  }

  await tx
    .update(receipts)
    .set({ ...hints, hintsEditedAt: new Date(), parsedAt: edits.items.length > 0 ? new Date() : null })
    .where(and(scoped.where(receipts, eq(receipts.id, receiptId))));
  return { success: true };
}
