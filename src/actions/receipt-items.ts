"use server";

import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { db as defaultDb, type LedgrDb } from "@/db";
import { categories, productAliases, receiptItems, receipts, transactionSplits, transactions } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { notDeleted } from "@/lib/query-helpers";
import { authorizeAction } from "@/lib/auth/authorize-action";
import { getHouseholdId } from "@/lib/auth/session";
import { withHousehold } from "@/lib/household-context";
import { receiptExtension, receiptsRoot } from "@/lib/receipts/paths";
import { readReceipt } from "@/lib/receipts/storage";
import { readReceiptText } from "@/lib/receipts/hints";
import {
  allocateSplits,
  applyAliases,
  cleanItems,
  normalizeRawName,
  reconcile,
} from "@/lib/receipts/items";
import { receiptModelBlocker, runReceiptModel, type ParseRunner } from "@/lib/receipts/parse-model";

const idSchema = z.string().min(1);

export interface ReceiptItemRow {
  id: string;
  lineNo: number;
  rawName: string;
  productName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  quantityMilli: number;
  totalCents: number;
}

export interface ReceiptItemsResult {
  items: ReceiptItemRow[];
  parsed: boolean;
  itemsTotalCents: number;
  /** Receipt (or transaction) total minus the lines: tax, fees, or a missed line. */
  gapCents: number | null;
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

async function loadItems(
  tx: LedgrDb,
  householdId: string,
  receiptId: string,
): Promise<ReceiptItemsResult | null> {
  const scoped = scopedQuery(householdId, tx);
  const [receipt] = await tx
    .select({
      parsedAt: receipts.parsedAt,
      hintTotalCents: receipts.hintTotalCents,
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

  const total = receipt.hintTotalCents ?? (receipt.txnAmount !== null ? Math.abs(receipt.txnAmount) : null);
  return { items, parsed: receipt.parsedAt !== null, ...reconcile(items, total) };
}

export async function fetchReceiptItems(
  receiptId: string,
  db: LedgrDb = defaultDb,
): Promise<{ data: ReceiptItemsResult } | { error: string }> {
  const householdId = await getHouseholdId();
  const parsed = idSchema.safeParse(receiptId);
  if (!parsed.success) return { error: "Invalid input" };
  const data = await withHousehold(householdId, (tx) => loadItems(tx, householdId, parsed.data), db);
  return data ? { data } : { error: "Receipt not found" };
}

/**
 * Reads the receipt's line items with the household's own model, then applies
 * the learned product dictionary on top. Re-running replaces earlier items.
 */
export async function parseReceiptItems(
  receiptId: string,
  db: LedgrDb = defaultDb,
  root: string = receiptsRoot(),
  run: ParseRunner = runReceiptModel,
  blocker: string | null = receiptModelBlocker(),
): Promise<{ data: ReceiptItemsResult } | { error: string }> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  const { householdId } = auth;
  const parsedId = idSchema.safeParse(receiptId);
  if (!parsedId.success) return { error: "Invalid input" };
  if (blocker) return { error: blocker };

  const found = await withHousehold(
    householdId,
    async (tx) => {
      const scoped = scopedQuery(householdId, tx);
      const [receipt] = await tx
        .select({ filePath: receipts.filePath })
        .from(receipts)
        .where(scoped.where(receipts, eq(receipts.id, parsedId.data)))
        .limit(1);
      const cats = await tx
        .select({ id: categories.id, name: categories.name, isIncome: categories.isIncome })
        .from(categories)
        .where(scoped.where(categories));
      return { receipt, cats: cats.filter((c) => !c.isIncome) };
    },
    db,
  );
  if (!found.receipt) return { error: "Receipt not found" };

  const ext = receiptExtension(found.receipt.filePath);
  const data = await readReceipt(found.receipt.filePath, root).catch(() => null);
  if (!ext || !data) return { error: "The receipt file is missing from storage" };

  let text: string | null = null;
  let image: { data: Buffer; mediaType: string } | null = null;
  if (IMAGE_TYPES[ext]) {
    image = { data, mediaType: IMAGE_TYPES[ext] };
  } else {
    text = await readReceiptText(ext, data);
    if (!text?.trim()) return { error: "No readable text in this file. Try a PDF with text, an image, or a .txt." };
  }

  let parsed;
  try {
    parsed = await run({ text, image, categoryNames: found.cats.map((c) => c.name) });
  } catch (e) {
    console.error("[receipts] item parsing failed", e);
    return { error: "The model couldn't read this receipt. Check that it is running and supports this file type." };
  }
  const cleaned = cleanItems(parsed, found.cats);
  if (cleaned.length === 0) return { error: "No line items were found on this receipt" };

  return withHousehold(
    householdId,
    async (tx) => {
      const scoped = scopedQuery(householdId, tx);
      const aliases = await tx
        .select({ rawKey: productAliases.rawKey, productName: productAliases.productName, categoryId: productAliases.categoryId })
        .from(productAliases)
        .where(scoped.where(productAliases));
      const items = applyAliases(cleaned, aliases);

      await tx.delete(receiptItems).where(scoped.where(receiptItems, eq(receiptItems.receiptId, parsedId.data)));
      await tx.insert(receiptItems).values(
        items.map((it, i) => ({
          id: uuid(),
          householdId,
          receiptId: parsedId.data,
          lineNo: i + 1,
          ...it,
        })),
      );
      await tx
        .update(receipts)
        .set({ parsedAt: new Date(), hintTotalCents: parsed.totalCents ? Math.round(parsed.totalCents) : undefined })
        .where(scoped.where(receipts, eq(receipts.id, parsedId.data)));
      const result = await loadItems(tx, householdId, parsedId.data);
      return result ? { data: result } : { error: "Receipt not found" };
    },
    db,
  );
}

const itemPatchSchema = z
  .object({
    productName: z.string().trim().min(1).max(120).nullable().optional(),
    categoryId: z.string().min(1).nullable().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, "Nothing to change");

/** Corrects an item and remembers the correction for every future receipt. */
export async function updateReceiptItem(
  itemId: string,
  patch: z.input<typeof itemPatchSchema>,
  db: LedgrDb = defaultDb,
): Promise<{ success: true } | { error: string }> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  const { householdId } = auth;
  const id = idSchema.safeParse(itemId);
  const fields = itemPatchSchema.safeParse(patch);
  if (!id.success || !fields.success) return { error: "Invalid input" };

  return withHousehold(
    householdId,
    async (tx) => {
      const scoped = scopedQuery(householdId, tx);
      const [item] = await tx
        .select({
          rawName: receiptItems.rawName,
          productName: receiptItems.productName,
          categoryId: receiptItems.categoryId,
        })
        .from(receiptItems)
        .where(scoped.where(receiptItems, eq(receiptItems.id, id.data)))
        .limit(1);
      if (!item) return { error: "Item not found" };

      if (fields.data.categoryId) {
        const [cat] = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(scoped.where(categories, eq(categories.id, fields.data.categoryId)))
          .limit(1);
        if (!cat) return { error: "Category not found" };
      }

      const next = {
        productName: fields.data.productName !== undefined ? fields.data.productName : item.productName,
        categoryId: fields.data.categoryId !== undefined ? fields.data.categoryId : item.categoryId,
      };
      await tx.update(receiptItems).set(next).where(scoped.where(receiptItems, eq(receiptItems.id, id.data)));

      await tx
        .insert(productAliases)
        .values({ id: uuid(), householdId, rawKey: normalizeRawName(item.rawName), ...next })
        .onConflictDoUpdate({
          target: [productAliases.householdId, productAliases.rawKey],
          set: { ...next, updatedAt: new Date() },
        });
      return { success: true as const };
    },
    db,
  );
}

/**
 * Replaces the transaction's splits with one per item category, sized to add up
 * to the transaction (tax and any uncategorized lines are spread across them).
 * Optional: nothing calls this unless the user asks.
 */
export async function createSplitsFromReceipt(
  receiptId: string,
  db: LedgrDb = defaultDb,
): Promise<{ data: { splits: number } } | { error: string }> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  const { householdId } = auth;
  const id = idSchema.safeParse(receiptId);
  if (!id.success) return { error: "Invalid input" };

  return withHousehold(
    householdId,
    async (tx) => {
      const scoped = scopedQuery(householdId, tx);
      const [row] = await tx
        .select({ transactionId: receipts.transactionId, amount: transactions.normalizedAmount })
        .from(receipts)
        .innerJoin(transactions, eq(receipts.transactionId, transactions.id))
        .where(scoped.where(receipts, eq(receipts.id, id.data), notDeleted(transactions)))
        .limit(1);
      if (!row?.transactionId) return { error: "Attach the receipt to a transaction first" };

      const items = await tx
        .select({ categoryId: receiptItems.categoryId, totalCents: receiptItems.totalCents })
        .from(receiptItems)
        .where(scoped.where(receiptItems, eq(receiptItems.receiptId, id.data)));
      const splits = allocateSplits(items, Math.abs(row.amount));
      if (!splits) return { error: "Give at least one item a category first" };

      await tx.delete(transactionSplits).where(eq(transactionSplits.transactionId, row.transactionId));
      await tx.insert(transactionSplits).values(
        splits.map((s) => ({ id: uuid(), transactionId: row.transactionId!, ...s, notes: "From receipt items" })),
      );
      await tx
        .update(transactions)
        .set({ categorySource: "manual", updatedAt: new Date() })
        .where(and(eq(transactions.id, row.transactionId), eq(transactions.householdId, householdId)));
      return { data: { splits: splits.length } };
    },
    db,
  );
}
