import { eq } from "drizzle-orm";
import type { LedgrDb } from "@/db";
import { receipts, transactions } from "@/db/schema";
import { centsToDisplay } from "@/lib/money";
import { scopedQuery } from "@/lib/scoped-query";

/**
 * Finds a receipt this household already stored with the same file hash and
 * says where it lives, so "already uploaded" can point at it. A receipt can be
 * attached to a visible transaction, to one that was hidden or deleted, or to
 * none at all (the unmatched tray).
 */
export async function findDuplicateReceipt(
  db: LedgrDb,
  householdId: string,
  sha256: string,
): Promise<{ id: string; where: string } | null> {
  const scoped = scopedQuery(householdId, db);
  const [row] = await db
    .select({
      id: receipts.id,
      transactionId: receipts.transactionId,
      txnName: transactions.name,
      txnDate: transactions.date,
      txnAmount: transactions.normalizedAmount,
      txnDeletedAt: transactions.deletedAt,
      txnHidden: transactions.isHidden,
    })
    .from(receipts)
    .leftJoin(transactions, eq(receipts.transactionId, transactions.id))
    .where(scoped.where(receipts, eq(receipts.sha256, sha256)))
    .limit(1);
  if (!row) return null;
  return { id: row.id, where: describeLocation(row) };
}

function describeLocation(row: {
  transactionId: string | null;
  txnName: string | null;
  txnDate: string | null;
  txnAmount: number | null;
  txnDeletedAt: Date | null;
  txnHidden: boolean | null;
}): string {
  if (!row.transactionId || row.txnName === null) return "it is in the unmatched receipts tray";
  const label = `"${row.txnName}" on ${row.txnDate} (${centsToDisplay(Math.abs(row.txnAmount ?? 0))})`;
  if (row.txnDeletedAt) return `it is attached to a deleted transaction, ${label}`;
  if (row.txnHidden) return `it is attached to a hidden transaction, ${label}`;
  return `it is attached to ${label}`;
}
