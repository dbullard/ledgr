import { and, desc, eq, isNull } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { LedgrDb } from "@/db";
import { categories, productAliases, receiptItems, receipts, transactions } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { notDeleted } from "@/lib/query-helpers";
import { todayDateString } from "@/lib/date-utils";
import type { ReceiptHints } from "./hints";
import { candidateTransactions } from "./ingest";
import { applyAliases, cleanItems, type ParsedReceipt } from "./items";
import { confidentMatch, suggestMatches, type Suggestion } from "./match";
import { MAX_RECEIPT_BYTES, RECEIPT_TYPES, receiptExtension, receiptsRoot } from "./paths";
import { deleteReceiptFile, moveReceipt, sha256Hex, writeReceipt } from "./storage";

export type ReceiptItemInput = ParsedReceipt["items"][number];

/** Plain-text rendering of a receipt, used as the stored file when no original is supplied. */
export function renderReceiptText(r: {
  merchant: string;
  date: string;
  items: { name: string; quantity?: number; totalCents: number }[];
  taxCents?: number | null;
  totalCents?: number | null;
}): string {
  const money = (c: number) => (c / 100).toFixed(2);
  const lines = [r.merchant, r.date, "-".repeat(40)];
  for (const it of r.items) {
    const q = it.quantity && it.quantity !== 1 ? ` x${it.quantity}` : "";
    lines.push(`${it.name}${q}  ${money(it.totalCents)}`);
  }
  lines.push("-".repeat(40));
  if (r.taxCents) lines.push(`TAX  ${money(r.taxCents)}`);
  if (r.totalCents) lines.push(`TOTAL  ${money(r.totalCents)}`);
  return lines.join("\n") + "\n";
}

async function itemContext(tx: LedgrDb, householdId: string) {
  const scoped = scopedQuery(householdId, tx);
  const cats = await tx
    .select({ id: categories.id, name: categories.name, isIncome: categories.isIncome })
    .from(categories)
    .where(scoped.where(categories));
  const aliases = await tx
    .select({
      rawKey: productAliases.rawKey,
      productName: productAliases.productName,
      categoryId: productAliases.categoryId,
    })
    .from(productAliases)
    .where(scoped.where(productAliases));
  return { cats: cats.filter((c) => !c.isIncome), aliases };
}

/**
 * Replaces a receipt's items with these (cleaned, categories snapped to the
 * household's, learned dictionary applied). Returns how many were stored.
 * `tx` must already be inside withHousehold.
 */
export async function replaceReceiptItems(
  tx: LedgrDb,
  householdId: string,
  receiptId: string,
  items: ReceiptItemInput[],
): Promise<number> {
  const { cats, aliases } = await itemContext(tx, householdId);
  const clean = applyAliases(cleanItems({ items }, cats), aliases);
  const scoped = scopedQuery(householdId, tx);
  await tx.delete(receiptItems).where(scoped.where(receiptItems, eq(receiptItems.receiptId, receiptId)));
  if (clean.length > 0) {
    await tx
      .insert(receiptItems)
      .values(clean.map((it, i) => ({ id: uuid(), householdId, receiptId, lineNo: i + 1, ...it })));
  }
  await tx
    .update(receipts)
    .set({ parsedAt: clean.length > 0 ? new Date() : null })
    .where(scoped.where(receipts, eq(receipts.id, receiptId)));
  return clean.length;
}

export type SaveReceiptResult =
  | { status: "error"; error: string }
  | { status: "duplicate"; receiptId: string }
  | {
      status: "attached" | "unmatched";
      receiptId: string;
      transactionId: string | null;
      itemCount: number;
      suggestions: {
        transactionId: string;
        name: string;
        date: string;
        amountCents: number;
        reasons: string[];
      }[];
    };

export interface SaveReceiptInput {
  householdId: string;
  /** Inside withHousehold for this household. */
  db: LedgrDb;
  source: "mcp" | "import" | "upload";
  merchant: string;
  /** YYYY-MM-DD */
  date: string;
  totalCents?: number | null;
  taxCents?: number | null;
  items: ReceiptItemInput[];
  /** Attach to this transaction; otherwise a clear match is attached and anything else waits. */
  transactionId?: string | null;
  /** The original file, if available; otherwise a text rendering is stored. */
  original?: { filename: string; data: Buffer };
  root?: string;
  today?: string;
}

/**
 * Saves a receipt whose contents are already known (read by Claude over MCP, or
 * taken from a store's order export): files it under <year>/<month>, attaches it
 * to a transaction when one clearly matches, and stores its items.
 */
export async function saveStructuredReceipt(opts: SaveReceiptInput): Promise<SaveReceiptResult> {
  const { householdId, db } = opts;
  const root = opts.root ?? receiptsRoot();
  const today = opts.today ?? todayDateString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) return { status: "error", error: "date must be YYYY-MM-DD" };
  const merchant = opts.merchant.trim().slice(0, 80);
  if (!merchant) return { status: "error", error: "merchant is required" };

  let ext = "txt";
  let data: Buffer;
  let filename: string;
  if (opts.original) {
    const e = receiptExtension(opts.original.filename);
    if (!e) return { status: "error", error: "Unsupported file type" };
    if (opts.original.data.length === 0) return { status: "error", error: "That file is empty" };
    if (opts.original.data.length > MAX_RECEIPT_BYTES) return { status: "error", error: "File is larger than 15 MB" };
    ext = e;
    data = opts.original.data;
    filename = opts.original.filename.slice(0, 255);
  } else {
    data = Buffer.from(
      renderReceiptText({
        merchant,
        date: opts.date,
        items: opts.items,
        taxCents: opts.taxCents,
        totalCents: opts.totalCents,
      }),
    );
    filename = `${opts.date}_${merchant}.txt`.slice(0, 255);
  }

  const sha256 = sha256Hex(data);
  const scoped = scopedQuery(householdId, db);
  const [dupe] = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(scoped.where(receipts, eq(receipts.sha256, sha256)))
    .limit(1);
  if (dupe) return { status: "duplicate", receiptId: dupe.id };

  const hints: ReceiptHints = { totalCents: opts.totalCents ?? null, date: opts.date, merchant };
  let txn: { id: string; date: string; name: string; normalizedAmount: number } | null = null;
  let suggestions: Suggestion[] = [];

  if (opts.transactionId) {
    const [t] = await db
      .select({
        id: transactions.id,
        date: transactions.date,
        name: transactions.name,
        normalizedAmount: transactions.normalizedAmount,
      })
      .from(transactions)
      .where(scoped.where(transactions, eq(transactions.id, opts.transactionId), notDeleted(transactions)))
      .limit(1);
    if (!t) return { status: "error", error: "Transaction not found" };
    txn = t;
  } else {
    suggestions = suggestMatches(hints, await candidateTransactions(householdId, hints, db, today));
    const m = confidentMatch(hints, suggestions);
    if (m) {
      txn = m.txn;
      suggestions = [];
    }
  }

  const rel = await writeReceipt(
    data,
    txn
      ? { date: txn.date, merchant: txn.name, amountCents: txn.normalizedAmount, ext }
      : { date: today, ext, hash: sha256 },
    root,
  );
  const id = uuid();
  try {
    await db.insert(receipts).values({
      id,
      householdId,
      transactionId: txn?.id ?? null,
      filePath: rel,
      originalFilename: filename,
      contentType: RECEIPT_TYPES[ext],
      sizeBytes: data.length,
      sha256,
      source: opts.source,
      hintTotalCents: hints.totalCents,
      hintDate: hints.date,
      hintMerchant: hints.merchant,
    });
    const itemCount = await replaceReceiptItems(db, householdId, id, opts.items);
    return {
      status: txn ? "attached" : "unmatched",
      receiptId: id,
      transactionId: txn?.id ?? null,
      itemCount,
      suggestions: suggestions.map((s) => ({
        transactionId: s.txn.id,
        name: s.txn.name,
        date: s.txn.date,
        amountCents: Math.abs(s.txn.normalizedAmount),
        reasons: s.reasons,
      })),
    };
  } catch (e) {
    await deleteReceiptFile(rel, root);
    throw e;
  }
}

/** Attaches an unmatched receipt to a transaction and renames its file to match. */
export async function attachReceiptToTransaction(
  tx: LedgrDb,
  householdId: string,
  receiptId: string,
  transactionId: string,
  root: string = receiptsRoot(),
): Promise<{ success: true } | { error: string }> {
  const scoped = scopedQuery(householdId, tx);
  const [receipt] = await tx
    .select({ filePath: receipts.filePath, transactionId: receipts.transactionId })
    .from(receipts)
    .where(scoped.where(receipts, eq(receipts.id, receiptId)))
    .limit(1);
  if (!receipt) return { error: "Receipt not found" };
  if (receipt.transactionId) return { error: "Receipt is already attached" };

  const [txn] = await tx
    .select({ date: transactions.date, name: transactions.name, normalizedAmount: transactions.normalizedAmount })
    .from(transactions)
    .where(scoped.where(transactions, eq(transactions.id, transactionId), notDeleted(transactions)))
    .limit(1);
  if (!txn) return { error: "Transaction not found" };

  const ext = receiptExtension(receipt.filePath);
  if (!ext) return { error: "Unsupported file type" };
  const newRel = await moveReceipt(
    receipt.filePath,
    { date: txn.date, merchant: txn.name, amountCents: txn.normalizedAmount, ext },
    root,
  );
  try {
    await tx
      .update(receipts)
      .set({ transactionId, filePath: newRel })
      .where(and(eq(receipts.id, receiptId), eq(receipts.householdId, householdId)));
  } catch (e) {
    await moveReceipt(newRel, { date: txn.date, ext, hash: receiptId }, root).catch(() => undefined);
    throw e;
  }
  return { success: true };
}

export interface UnmatchedReceiptRow {
  id: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
  hintTotalCents: number | null;
  hintDate: string | null;
  hintMerchant: string | null;
  suggestions: {
    transactionId: string;
    name: string;
    date: string;
    amountCents: number;
    reasons: string[];
  }[];
}

/** Receipts not yet tied to a transaction, each with up to three suggested matches. */
export async function listUnmatchedReceipts(
  tx: LedgrDb,
  householdId: string,
  limit = 200,
): Promise<UnmatchedReceiptRow[]> {
  const rows = await tx
    .select({
      id: receipts.id,
      originalFilename: receipts.originalFilename,
      contentType: receipts.contentType,
      sizeBytes: receipts.sizeBytes,
      createdAt: receipts.createdAt,
      hintTotalCents: receipts.hintTotalCents,
      hintDate: receipts.hintDate,
      hintMerchant: receipts.hintMerchant,
    })
    .from(receipts)
    .where(scopedQuery(householdId, tx).where(receipts, isNull(receipts.transactionId)))
    .orderBy(desc(receipts.createdAt))
    .limit(limit);

  const out: UnmatchedReceiptRow[] = [];
  for (const r of rows) {
    const hints = { totalCents: r.hintTotalCents, date: r.hintDate, merchant: r.hintMerchant };
    const suggestions = suggestMatches(hints, await candidateTransactions(householdId, hints, tx)).map((s) => ({
      transactionId: s.txn.id,
      name: s.txn.name,
      date: s.txn.date,
      amountCents: Math.abs(s.txn.normalizedAmount),
      reasons: s.reasons,
    }));
    out.push({ ...r, suggestions });
  }
  return out;
}

/** Replaces the items of an existing receipt of this household. */
export async function setItemsForReceipt(
  tx: LedgrDb,
  householdId: string,
  receiptId: string,
  items: ReceiptItemInput[],
): Promise<{ itemCount: number } | { error: string }> {
  const [r] = await tx
    .select({ id: receipts.id })
    .from(receipts)
    .where(scopedQuery(householdId, tx).where(receipts, eq(receipts.id, receiptId)))
    .limit(1);
  if (!r) return { error: "Receipt not found" };
  return { itemCount: await replaceReceiptItems(tx, householdId, receiptId, items) };
}
