import { and, eq, lt, gte, lte, inArray, notInArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import { db as defaultDb, type LedgrDb } from "@/db";
import {
  transactions,
  transactionSplits,
  categories,
  categoryGroups,
} from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { notDeleted, sumCol, isVisibleTransaction } from "@/lib/query-helpers";
import { UNCATEGORIZED, resolvedCategoryLabel } from "@/lib/labels";
import { getExcludedCategoryIds, getIncomeCategoryIds, includedInSpending, notIncome } from "@/queries/shared-conditions";
import type { ReportFilters } from "@/queries/reports";

export interface SpendingChartItem {
  id: string | null;
  name: string;
  value: number;
  groupName: string | null;
  groupId: string | null;
  categoryIcon: string | null;
}


/**
 * The one definition of spending. Every Reports tab that answers "how much did
 * I spend?" builds on this, and so does the drill-down that explains any of
 * those figures: a settled charge outside an income category, net of refunds.
 * A refund is a credit filed under a (non-income) category; it offsets spending
 * in that category. An uncategorized credit is never a refund (it may be a
 * deposit or a paycheck), so it stays out. Transfer rows count only when their
 * category explicitly opts into spending reports.
 */
export async function spendingBaseConditions(householdId: string, filters: ReportFilters, db: LedgrDb) {
  const conditions = [
    notDeleted(transactions),
    isVisibleTransaction(transactions),
    or(lt(transactions.normalizedAmount, 0), isNotNull(transactions.categoryId))!,
    eq(transactions.pending, false),
    await includedInSpending(householdId, db),
    gte(transactions.date, filters.dateFrom),
    lte(transactions.date, filters.dateTo),
    await notIncome(householdId, db),
  ];
  if (filters.accountIds?.length) {
    conditions.push(inArray(transactions.accountId, filters.accountIds));
  }
  return conditions;
}

/**
 * The income counterpart, matching the Sankey's income nodes and the Income vs
 * Expense category table: settled, non-transfer rows in an income category,
 * summed by magnitude. Note this is *not* the Total Income tile's definition,
 * which also counts uncategorized credits — that gap is the open gross-vs-net
 * product question, deliberately left alone here.
 */
export async function incomeBaseConditions(householdId: string, filters: ReportFilters, db: LedgrDb) {
  const incomeCatIds = await getIncomeCategoryIds(householdId, db);
  const conditions = [
    notDeleted(transactions),
    isVisibleTransaction(transactions),
    eq(transactions.pending, false),
    eq(transactions.isTransfer, false),
    isNull(transactions.transferPairId),
    gte(transactions.date, filters.dateFrom),
    lte(transactions.date, filters.dateTo),
    incomeCatIds.size > 0
      ? inArray(transactions.categoryId, [...incomeCatIds])
      : sql`false`,
  ];
  if (filters.accountIds?.length) {
    conditions.push(inArray(transactions.accountId, filters.accountIds));
  }
  return conditions;
}


async function findSplitParentIds(
  scoped: ReturnType<typeof scopedQuery>,
  conditions: Awaited<ReturnType<typeof spendingBaseConditions>>,
  db: LedgrDb,
): Promise<string[]> {
  const rows = await db
    .select({ transactionId: transactionSplits.transactionId })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
    .where(scoped.where(transactions, ...conditions, lt(transactions.normalizedAmount, 0)))
    .groupBy(transactionSplits.transactionId, transactions.normalizedAmount)
    // Only a fully allocated charge is represented by its splits. A partial
    // split would otherwise drop the unallocated remainder from every total, so
    // until the splits add up the charge counts whole under its own category.
    .having(sql`SUM(${transactionSplits.amount}) >= ABS(${transactions.normalizedAmount})`);
  return rows.map((r) => r.transactionId);
}


export async function aggregateSpending(
  householdId: string,
  filters: ReportFilters,
  db: LedgrDb = defaultDb,
): Promise<Map<string, number>> {
  const scoped = scopedQuery(householdId, db);
  const conditions = await spendingBaseConditions(householdId, filters, db);

  const splitParentIds = await findSplitParentIds(scoped, conditions, db);

  // Non-split transactions
  let nonSplitConditions =
    splitParentIds.length > 0
      ? [...conditions, notInArray(transactions.id, splitParentIds)]
      : conditions;
  if (filters.categoryIds?.length) {
    nonSplitConditions = [
      ...nonSplitConditions,
      inArray(transactions.categoryId, filters.categoryIds),
    ];
  }

  const nonSplitRows = await db
    .select({
      categoryId: transactions.categoryId,
      // Signed: charges are negative, refunds positive, so the negated sum is
      // spending net of refunds.
      total: sql<number>`COALESCE(-SUM(${transactions.normalizedAmount}), 0)`.mapWith(Number),
    })
    .from(transactions)
    .where(scoped.where(transactions, ...nonSplitConditions))
    .groupBy(transactions.categoryId);

  const spending = new Map<string, number>();
  for (const row of nonSplitRows) {
    const key = row.categoryId ?? "uncategorized";
    spending.set(key, (spending.get(key) ?? 0) + row.total);
  }

  // Split transactions
  if (splitParentIds.length > 0) {
    const splitRows = await db
      .select({
        categoryId: transactionSplits.categoryId,
        total: sumCol(transactionSplits.amount),
      })
      .from(transactionSplits)
      .where(
        filters.categoryIds?.length
          ? and(
              inArray(transactionSplits.transactionId, splitParentIds),
              inArray(transactionSplits.categoryId, filters.categoryIds),
            )
          : inArray(transactionSplits.transactionId, splitParentIds),
      )
      .groupBy(transactionSplits.categoryId);

    const excluded = new Set(await getExcludedCategoryIds(householdId, db));
    // A split filed under an income category is not spending, same as an
    // unsplit charge there (see notIncome).
    const incomeIds = await getIncomeCategoryIds(householdId, db);
    for (const row of splitRows) {
      if (excluded.has(row.categoryId) || incomeIds.has(row.categoryId)) continue;
      spending.set(row.categoryId, (spending.get(row.categoryId) ?? 0) + row.total);
    }
  }

  // Refunds offset spending within their own category; a category whose refunds
  // outweigh its charges is not spending, so it is dropped rather than negative.
  for (const [key, value] of spending) {
    if (value <= 0) spending.delete(key);
  }

  return spending;
}

export async function enrichSpendingMap(
  spending: Map<string, number>,
  db: LedgrDb = defaultDb,
): Promise<SpendingChartItem[]> {
  const categoryIds = [...spending.keys()].filter((k) => k !== "uncategorized");

  type CatRow = {
    id: string;
    name: string;
    groupName: string | null;
    groupId: string | null;
    categoryIcon: string | null;
  };
  let catRows: CatRow[] = [];
  if (categoryIds.length > 0) {
    catRows = await db
      .select({
        id: categories.id,
        name: categories.name,
        groupName: categoryGroups.name,
        groupId: categoryGroups.id,
        categoryIcon: categories.icon,
      })
      .from(categories)
      .leftJoin(categoryGroups, eq(categories.groupId, categoryGroups.id))
      .where(inArray(categories.id, categoryIds));
  }

  const catMap = new Map(catRows.map((c) => [c.id, c]));
  const result: SpendingChartItem[] = [];

  for (const [key, value] of spending.entries()) {
    if (key === "uncategorized") {
      result.push({
        id: null,
        name: UNCATEGORIZED,
        value,
        groupName: null,
        groupId: null,
        categoryIcon: null,
      });
    } else {
      const cat = catMap.get(key);
      result.push({
        id: key,
        name: resolvedCategoryLabel(cat?.name),
        value,
        groupName: cat?.groupName ?? null,
        groupId: cat?.groupId ?? null,
        categoryIcon: cat?.categoryIcon ?? null,
      });
    }
  }

  return result.sort((a, b) => b.value - a.value);
}
