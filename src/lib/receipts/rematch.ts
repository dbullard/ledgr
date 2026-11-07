import fs from "node:fs/promises";
import { and, eq, isNull } from "drizzle-orm";
import type { LedgrDb } from "@/db";
import { receipts } from "@/db/schema";
import { withHousehold } from "@/lib/household-context";
import { confidentMatch, suggestMatches } from "./match";
import { attachReceiptToTransaction, listUnmatchedReceipts } from "./service";
import { candidateTransactions } from "./ingest";
import { extractHints, readReceiptText } from "./hints";
import { receiptExtension, receiptsRoot, resolveReceiptPath } from "./paths";

/** Text-based files are cheap to re-read; photos would need OCR every time, so they are skipped. */
const REREADABLE = new Set(["pdf", "txt", "eml"]);

/**
 * Re-reads each waiting receipt and refreshes its stored amount when the
 * reading rules have improved since upload (e.g. delivery tips now count).
 * Only the amount, and only when it was read from the file's text.
 */
async function refreshWaitingAmounts(tx: LedgrDb, householdId: string, root: string): Promise<void> {
  const waiting = await tx
    .select({
      id: receipts.id,
      filePath: receipts.filePath,
      originalFilename: receipts.originalFilename,
      hintTotalCents: receipts.hintTotalCents,
    })
    .from(receipts)
    .where(and(eq(receipts.householdId, householdId), isNull(receipts.transactionId)));
  for (const r of waiting) {
    const ext = receiptExtension(r.originalFilename);
    if (!ext || !REREADABLE.has(ext)) continue;
    try {
      const text = await readReceiptText(ext, await fs.readFile(resolveReceiptPath(r.filePath, root)));
      const total = text ? extractHints(r.originalFilename, text).totalCents : null;
      if (total !== null && total !== r.hintTotalCents) {
        await tx.update(receipts).set({ hintTotalCents: total }).where(eq(receipts.id, r.id));
      }
    } catch {
      // A missing or unreadable file keeps its old hint.
    }
  }
}

/**
 * After new transactions arrive from a bank, give receipts that were waiting
 * a second chance: attach each one that now has a single clear match (same
 * rule as at upload). Anything ambiguous stays in the waiting list.
 * Never throws: a sync must not fail because of a receipt.
 */
export async function rematchWaitingReceipts(
  householdId: string,
  db?: LedgrDb,
  root: string = receiptsRoot(),
): Promise<number> {
  try {
    return await withHousehold(
      householdId,
      async (tx) => {
        await refreshWaitingAmounts(tx, householdId, root);
        const waiting = await listUnmatchedReceipts(tx, householdId, 200);
        let attached = 0;
        const taken = new Set<string>();
        for (const r of waiting) {
          if (r.autoMatchBlocked || r.hintTotalCents === null || !r.hintDate) continue;
          const hints = { totalCents: r.hintTotalCents, date: r.hintDate, merchant: r.hintMerchant };
          const candidates = (await candidateTransactions(householdId, hints, tx)).filter((c) => !taken.has(c.id));
          const match = confidentMatch(hints, suggestMatches(hints, candidates));
          if (!match) continue;
          const res = await attachReceiptToTransaction(tx, householdId, r.id, match.txn.id, root);
          if ("success" in res) {
            taken.add(match.txn.id);
            attached += 1;
          }
        }
        return attached;
      },
      db,
    );
  } catch (e) {
    console.error("[receipts] rematch after sync failed", e);
    return 0;
  }
}
