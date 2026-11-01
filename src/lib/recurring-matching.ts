import { and, eq, ilike, inArray, isNotNull, isNull } from "drizzle-orm";
import { db as defaultDb, type LedgrDb } from "@/db";
import { recurringExclusions, recurringTransactions, transactions } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { notDeleted } from "@/lib/query-helpers";
import { withHousehold } from "@/lib/household-context";
import { matchesRules, nextDateAfter, type Frequency } from "@/lib/recurring-match";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * Links unlinked, settled, non-transfer transactions to the recurring items
 * whose match rules they satisfy, then moves each item's last/next date
 * forward. Never touches a transaction that already belongs to an item or that
 * the user took out of this one. Returns how many transactions it linked.
 */
export async function applyRecurringMatching(
  householdId: string,
  db: LedgrDb = defaultDb,
): Promise<number> {
  return withHousehold(
    householdId,
    async (tx) => {
      const scoped = scopedQuery(householdId, tx);
      const items = await tx
        .select()
        .from(recurringTransactions)
        .where(
          scoped.where(
            recurringTransactions,
            eq(recurringTransactions.status, "active"),
            isNotNull(recurringTransactions.matchName),
          ),
        );

      let linked = 0;
      const now = new Date();

      for (const item of items) {
        const needle = item.matchName?.trim();
        if (!needle) continue;

        const excluded = await tx
          .select({ transactionId: recurringExclusions.transactionId })
          .from(recurringExclusions)
          .where(eq(recurringExclusions.recurringId, item.id));
        const excludedIds = new Set(excluded.map((e) => e.transactionId));

        const candidates = await tx
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
              eq(transactions.pending, false),
              eq(transactions.isTransfer, false),
              isNull(transactions.recurringTransactionId),
              ilike(transactions.name, `%${escapeLike(needle)}%`),
            ),
          );

        const matched = candidates
          .filter((c) => !excludedIds.has(c.id))
          // Expenses are outflows (negative); income items the reverse.
          .filter((c) => (item.isIncome ? c.normalizedAmount > 0 : c.normalizedAmount < 0))
          .filter((c) => matchesRules(c, item));
        if (matched.length === 0) continue;

        await tx
          .update(transactions)
          .set({ recurringTransactionId: item.id, updatedAt: now })
          .where(
            and(
              inArray(transactions.id, matched.map((m) => m.id)),
              eq(transactions.householdId, householdId),
            ),
          );
        linked += matched.length;

        const newest = matched.reduce((a, b) => (a.date >= b.date ? a : b));
        if (!item.lastDate || newest.date >= item.lastDate) {
          await tx
            .update(recurringTransactions)
            .set({
              lastDate: newest.date,
              lastAmount: newest.normalizedAmount,
              ...(item.frequency
                ? { nextDate: nextDateAfter(newest.date, item.frequency as Frequency) }
                : {}),
              updatedAt: now,
            })
            .where(eq(recurringTransactions.id, item.id));
        }
      }

      return linked;
    },
    db,
  );
}
