"use server";

import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { db as defaultDb, type LedgrDb } from "@/db";
import { receipts, transactions } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { notDeleted } from "@/lib/query-helpers";
import { authorizeAction } from "@/lib/auth/authorize-action";
import { getHouseholdId } from "@/lib/auth/session";
import { withHousehold } from "@/lib/household-context";
import {
  MAX_RECEIPT_BYTES,
  RECEIPT_TYPES,
  receiptExtension,
  receiptsRoot,
} from "@/lib/receipts/paths";
import { deleteReceiptFile, sha256Hex, writeReceipt } from "@/lib/receipts/storage";
import { ingestReceipt } from "@/lib/receipts/ingest";
import { attachReceiptToTransaction, listUnmatchedReceipts } from "@/lib/receipts/service";

const idSchema = z.string().min(1);

export interface ReceiptSummary {
  id: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

const summaryColumns = {
  id: receipts.id,
  originalFilename: receipts.originalFilename,
  contentType: receipts.contentType,
  sizeBytes: receipts.sizeBytes,
  createdAt: receipts.createdAt,
};

function toSummary(r: {
  id: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
}): ReceiptSummary {
  return { ...r, createdAt: r.createdAt.toISOString() };
}

/** Receipts attached to one transaction, newest first. Receipts are optional; empty is normal. */
export async function fetchReceipts(
  transactionId: string,
  db: LedgrDb = defaultDb,
): Promise<{ data: ReceiptSummary[] } | { error: string }> {
  const householdId = await getHouseholdId();
  const parsed = idSchema.safeParse(transactionId);
  if (!parsed.success) return { error: "Invalid input" };

  const rows = await withHousehold(
    householdId,
    (tx) =>
      tx
        .select(summaryColumns)
        .from(receipts)
        .where(
          scopedQuery(householdId, tx).where(receipts, eq(receipts.transactionId, parsed.data)),
        )
        .orderBy(desc(receipts.createdAt)),
    db,
  );
  return { data: rows.map(toSummary) };
}

/**
 * Stores an uploaded file under <root>/<YYYY>/<MM>/ named after the
 * transaction's date, merchant and amount, and attaches it. Never blocks or
 * changes the transaction itself.
 */
export async function uploadReceipt(
  transactionId: string,
  formData: FormData,
  db: LedgrDb = defaultDb,
  root: string = receiptsRoot(),
): Promise<{ data: ReceiptSummary } | { error: string }> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  const { householdId } = auth;

  const parsedId = idSchema.safeParse(transactionId);
  const file = formData.get("file");
  if (!parsedId.success || !(file instanceof File)) return { error: "Invalid input" };

  const ext = receiptExtension(file.name);
  if (!ext) return { error: "Unsupported file type. Use PDF, PNG, JPG, WEBP, HEIC, TXT or EML." };
  if (file.size === 0) return { error: "That file is empty" };
  if (file.size > MAX_RECEIPT_BYTES) return { error: "File is larger than 15 MB" };

  const data = Buffer.from(await file.arrayBuffer());
  const sha256 = sha256Hex(data);

  return withHousehold(
    householdId,
    async (tx) => {
      const scoped = scopedQuery(householdId, tx);
      const [txn] = await tx
        .select({
          date: transactions.date,
          name: transactions.name,
          normalizedAmount: transactions.normalizedAmount,
        })
        .from(transactions)
        .where(scoped.where(transactions, eq(transactions.id, parsedId.data), notDeleted(transactions)))
        .limit(1);
      if (!txn) return { error: "Transaction not found" };

      const [dupe] = await tx
        .select({ id: receipts.id })
        .from(receipts)
        .where(scoped.where(receipts, eq(receipts.sha256, sha256)))
        .limit(1);
      if (dupe) return { error: "This receipt was already uploaded" };

      const rel = await writeReceipt(
        data,
        { date: txn.date, merchant: txn.name, amountCents: txn.normalizedAmount, ext },
        root,
      );
      try {
        const [row] = await tx
          .insert(receipts)
          .values({
            id: uuid(),
            householdId,
            transactionId: parsedId.data,
            filePath: rel,
            originalFilename: file.name.slice(0, 255),
            contentType: RECEIPT_TYPES[ext],
            sizeBytes: file.size,
            sha256,
            source: "upload",
          })
          .returning(summaryColumns);
        return { data: toSummary(row) };
      } catch (e) {
        await deleteReceiptFile(rel, root);
        throw e;
      }
    },
    db,
  );
}

/** Removes the row and the file. The transaction is untouched. */
export async function deleteReceipt(
  receiptId: string,
  db: LedgrDb = defaultDb,
  root: string = receiptsRoot(),
): Promise<{ success: true } | { error: string }> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  const { householdId } = auth;

  const parsed = idSchema.safeParse(receiptId);
  if (!parsed.success) return { error: "Invalid input" };

  const removed = await withHousehold(
    householdId,
    (tx) =>
      tx
        .delete(receipts)
        .where(and(eq(receipts.householdId, householdId), eq(receipts.id, parsed.data)))
        .returning({ filePath: receipts.filePath }),
    db,
  );
  if (removed.length === 0) return { error: "Receipt not found" };

  await deleteReceiptFile(removed[0].filePath, root);
  return { success: true };
}

export interface ReceiptSuggestion {
  transactionId: string;
  name: string;
  date: string;
  amountCents: number;
  reasons: string[];
}

export interface UnmatchedReceipt extends ReceiptSummary {
  hintTotalCents: number | null;
  hintDate: string | null;
  hintMerchant: string | null;
  suggestions: ReceiptSuggestion[];
}

/**
 * Stores a receipt with no transaction chosen. It is attached on arrival only
 * when exactly one transaction clearly matches; otherwise it joins the tray.
 */
export async function uploadUnmatchedReceipt(
  formData: FormData,
  db: LedgrDb = defaultDb,
  root: string = receiptsRoot(),
): Promise<
  | { status: "attached"; transactionId: string }
  | { status: "unmatched" }
  | { status: "duplicate" }
  | { error: string }
> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "Invalid input" };
  if (!receiptExtension(file.name)) {
    return { error: "Unsupported file type. Use PDF, PNG, JPG, WEBP, HEIC, TXT or EML." };
  }
  if (file.size > MAX_RECEIPT_BYTES) return { error: "File is larger than 15 MB" };

  const data = Buffer.from(await file.arrayBuffer());
  const res = await withHousehold(
    auth.householdId,
    (tx) =>
      ingestReceipt({
        householdId: auth.householdId,
        data,
        filename: file.name,
        source: "upload",
        db: tx,
        root,
      }),
    db,
  );
  if (res.status === "rejected") return { error: res.error };
  if (res.status === "duplicate") return { status: "duplicate" };
  return res.transactionId
    ? { status: "attached", transactionId: res.transactionId }
    : { status: "unmatched" };
}

/** Receipts not yet tied to a transaction, each with up to three suggested matches. */
export async function fetchUnmatchedReceipts(
  db: LedgrDb = defaultDb,
): Promise<{ data: UnmatchedReceipt[] } | { error: string }> {
  const householdId = await getHouseholdId();
  const rows = await withHousehold(householdId, (tx) => listUnmatchedReceipts(tx, householdId), db);
  return { data: rows.map((r) => ({ ...toSummary(r), hintTotalCents: r.hintTotalCents, hintDate: r.hintDate, hintMerchant: r.hintMerchant, suggestions: r.suggestions })) };
}

/** Attaches an unmatched receipt to a transaction and renames the file to match it. */
export async function attachReceipt(
  receiptId: string,
  transactionId: string,
  db: LedgrDb = defaultDb,
  root: string = receiptsRoot(),
): Promise<{ success: true } | { error: string }> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  const { householdId } = auth;
  const parsedReceipt = idSchema.safeParse(receiptId);
  const parsedTxn = idSchema.safeParse(transactionId);
  if (!parsedReceipt.success || !parsedTxn.success) return { error: "Invalid input" };

  return withHousehold(
    householdId,
    (tx) => attachReceiptToTransaction(tx, householdId, parsedReceipt.data, parsedTxn.data, root),
    db,
  );
}
