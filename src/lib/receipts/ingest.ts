import { eq, gte, lte, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { LedgrDb } from "@/db";
import { receipts, transactions } from "@/db/schema";
import { isVisibleTransaction, notDeleted } from "@/lib/query-helpers";
import { scopedQuery } from "@/lib/scoped-query";
import { todayDateString } from "@/lib/date-utils";
import { extractHints, findDate, readReceiptText, type ReceiptHints } from "./hints";
import { renderPdfPages } from "./ocr";
import { receiptModelBlocker, runReceiptModel } from "./parse-model";
import type { ParsedReceipt } from "./items";
import { replaceReceiptItems } from "./service";
import { confidentMatch, suggestMatches, type Suggestion, type TxnCandidate } from "./match";
import { MAX_RECEIPT_BYTES, RECEIPT_TYPES, receiptExtension, receiptsRoot } from "./paths";
import { deleteReceiptFile, sha256Hex, writeReceipt } from "./storage";

function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Transactions a receipt with these hints could belong to. */
export async function candidateTransactions(
  householdId: string,
  hints: ReceiptHints,
  db: LedgrDb,
  today: string = todayDateString(),
): Promise<TxnCandidate[]> {
  // With no date to anchor on, look back 90 days; with no amount either there
  // is nothing to narrow by, so suggest nothing.
  if (hints.totalCents === null && !hints.date) return [];
  const from = hints.date ? shiftDays(hints.date, -10) : shiftDays(today, -90);
  const to = hints.date ? shiftDays(hints.date, 10) : today;
  const scoped = scopedQuery(householdId, db);
  return db
    .select({
      id: transactions.id,
      name: transactions.name,
      date: transactions.date,
      normalizedAmount: transactions.normalizedAmount,
    })
    .from(transactions)
    .where(
      scoped.where(
        transactions,
        notDeleted(transactions),
        isVisibleTransaction(transactions),
        gte(transactions.date, from),
        lte(transactions.date, to),
        hints.totalCents !== null
          ? sql`abs(${transactions.normalizedAmount}) = ${hints.totalCents}`
          : undefined,
      ),
    )
    .limit(500);
}

const VISION_EXTS: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

/**
 * Second chance for a photo or scan whose OCR found no total: ask the household's
 * own vision model for just the total, date and merchant. Skipped when no local
 * model is configured; never throws, and never waits longer than the timeout.
 */
export async function visionHints(
  ext: string,
  data: Buffer,
  blocker: string | null = receiptModelBlocker(),
): Promise<Partial<ReceiptHints>> {
  if (blocker) return {};
  try {
    const image = VISION_EXTS[ext]
      ? { data, mediaType: VISION_EXTS[ext] }
      : ext === "pdf"
        ? await renderPdfPages(data, 1).then((p) => (p[0] ? { data: p[0], mediaType: "image/png" } : null))
        : null;
    if (!image) return {};
    const out = await Promise.race([
      runReceiptModel({ text: null, image, categoryNames: [] }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 45_000)),
    ]);
    if (!out) return {};
    const total = out.totalCents && out.totalCents > 0 ? Math.round(out.totalCents) : null;
    const date = out.date ? findDate(out.date) : null;
    return { totalCents: total, date, merchant: out.merchant?.trim().slice(0, 80) || null };
  } catch (e) {
    console.error("[receipts] vision hints failed", e);
    return {};
  }
}

export type IngestResult =
  | { status: "duplicate" }
  | { status: "rejected"; error: string }
  | {
      status: "stored";
      receiptId: string;
      /** Set when the receipt was confidently attached on arrival. */
      transactionId: string | null;
      hints: ReceiptHints;
      suggestions: Suggestion[];
    };

/**
 * Stores a receipt that arrives with no transaction chosen (the tray, the
 * inbox folder). Reads hints, and attaches it only when one transaction is an
 * unambiguous match; otherwise it waits, unmatched, with suggestions.
 * `db` must already be inside withHousehold for this household.
 */
export async function ingestReceipt(opts: {
  householdId: string;
  data: Buffer;
  filename: string;
  source: "upload" | "folder" | "email" | "extension" | "mcp" | "import";
  db: LedgrDb;
  root?: string;
  today?: string;
  /** Already read on the user's device; fills in what OCR missed and stores the items. */
  parsed?: ParsedReceipt | null;
}): Promise<IngestResult> {
  const { householdId, data, filename, source, db } = opts;
  const root = opts.root ?? receiptsRoot();
  const today = opts.today ?? todayDateString();

  const ext = receiptExtension(filename);
  if (!ext) return { status: "rejected", error: "Unsupported file type" };
  if (data.length === 0) return { status: "rejected", error: "That file is empty" };
  if (data.length > MAX_RECEIPT_BYTES) return { status: "rejected", error: "File is larger than 15 MB" };

  const sha256 = sha256Hex(data);
  const scoped = scopedQuery(householdId, db);
  const [dupe] = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(scoped.where(receipts, eq(receipts.sha256, sha256)))
    .limit(1);
  if (dupe) return { status: "duplicate" };

  const text = await readReceiptText(ext, data);
  let hints = extractHints(filename, text);
  const onDevice = opts.parsed ?? null;
  if (onDevice) {
    const total = onDevice.totalCents && onDevice.totalCents > 0 ? Math.round(onDevice.totalCents) : null;
    hints = {
      totalCents: hints.totalCents ?? total,
      date: hints.date ?? (onDevice.date ? findDate(onDevice.date) : null),
      merchant: hints.merchant ?? (onDevice.merchant?.trim().slice(0, 80) || null),
    };
  }
  // Photos and scans only: a text file or text PDF with no total has nothing more to find.
  const needsEyes = ext !== "txt" && ext !== "eml" && (ext !== "pdf" || (text ?? "").length < 200);
  if (hints.totalCents === null && needsEyes) {
    const v = await visionHints(ext, data);
    hints = {
      totalCents: v.totalCents ?? hints.totalCents,
      date: hints.date ?? v.date ?? null,
      merchant: hints.merchant ?? v.merchant ?? null,
    };
  }
  const suggestions = suggestMatches(hints, await candidateTransactions(householdId, hints, db, today));
  const match = confidentMatch(hints, suggestions);

  const rel = await writeReceipt(
    data,
    match
      ? { date: match.txn.date, merchant: match.txn.name, amountCents: match.txn.normalizedAmount, ext }
      : { date: today, ext, hash: sha256 },
    root,
  );
  const id = uuid();
  try {
    await db.insert(receipts).values({
      id,
      householdId,
      transactionId: match?.txn.id ?? null,
      filePath: rel,
      originalFilename: filename.slice(0, 255),
      contentType: RECEIPT_TYPES[ext],
      sizeBytes: data.length,
      sha256,
      source,
      hintTotalCents: hints.totalCents,
      hintDate: hints.date,
      hintMerchant: hints.merchant,
    });
  } catch (e) {
    await deleteReceiptFile(rel, root);
    throw e;
  }
  if (onDevice && onDevice.items.length > 0) {
    try {
      await replaceReceiptItems(db, householdId, id, onDevice.items);
    } catch (e) {
      console.error("[receipts] storing on-device items failed", e);
    }
  }
  return {
    status: "stored",
    receiptId: id,
    transactionId: match?.txn.id ?? null,
    hints,
    suggestions: match ? [] : suggestions,
  };
}

