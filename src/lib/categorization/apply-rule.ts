import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { LedgrDb } from "@/db";
import { merchants, transactions, transactionSplits } from "@/db/schema";
import { isVisibleTransaction, notDeleted } from "@/lib/query-helpers";

/** Category sources that are a guess, so a new rule may overwrite them. */
const GUESSED_SOURCES = ["ai", "ai_low_confidence", "history"] as const;

export interface RuleTarget {
  categoryId: string;
  matchField: "name" | "merchant";
  /** Already normalized (trimmed, non-empty). */
  matchPattern: string;
}

/**
 * Existing transactions a new rule should file. The same case-insensitive
 * substring match the sync engine uses, but only over rows nobody has made a
 * decision about: uncategorized or guessed. Manual choices, other rules,
 * merchant defaults and the bank's own labels stay as they are, as do
 * transfers, hidden or deleted rows, and split transactions (whose category
 * lives on the splits).
 *
 * The match uses position() rather than LIKE so a `%` or `_` in the pattern
 * is matched literally.
 */
function targetCondition(householdId: string, rule: RuleTarget): SQL {
  const needle = rule.matchPattern.toLowerCase();
  const matches =
    rule.matchField === "merchant"
      ? sql`EXISTS (
          SELECT 1 FROM ${merchants}
          WHERE ${merchants.id} = ${transactions.merchantId}
            AND position(${needle} in lower(${merchants.name})) > 0
        )`
      : sql`position(${needle} in lower(${transactions.name})) > 0`;

  return and(
    eq(transactions.householdId, householdId),
    notDeleted(transactions),
    isVisibleTransaction(transactions),
    eq(transactions.isTransfer, false),
    or(isNull(transactions.categoryId), inArray(transactions.categorySource, [...GUESSED_SOURCES])),
    sql`NOT EXISTS (SELECT 1 FROM ${transactionSplits} WHERE ${transactionSplits.transactionId} = ${transactions.id})`,
    matches,
  )!;
}

export async function countRuleTargets(householdId: string, rule: RuleTarget, tx: LedgrDb): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .where(targetCondition(householdId, rule));
  return row?.n ?? 0;
}

/** Files every target under the rule's category as source "rule". Returns how many changed. */
export async function applyRuleToTargets(householdId: string, rule: RuleTarget, tx: LedgrDb): Promise<number> {
  const ids = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(targetCondition(householdId, rule));
  if (ids.length === 0) return 0;

  const updated = await tx
    .update(transactions)
    .set({ categoryId: rule.categoryId, categorySource: "rule", updatedAt: new Date() })
    .where(
      and(
        eq(transactions.householdId, householdId),
        inArray(transactions.id, ids.map((r) => r.id)),
      ),
    )
    .returning({ id: transactions.id });
  return updated.length;
}
