import type { LedgrDb } from "@/db";
import { withHousehold } from "@/lib/household-context";
import { confidentMatch, suggestMatches } from "./match";
import { attachReceiptToTransaction, listUnmatchedReceipts } from "./service";
import { candidateTransactions } from "./ingest";
import { receiptsRoot } from "./paths";

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
        const waiting = await listUnmatchedReceipts(tx, householdId, 200);
        let attached = 0;
        const taken = new Set<string>();
        for (const r of waiting) {
          if (r.hintTotalCents === null || !r.hintDate) continue;
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
