import { eq, asc, ilike, isNull, isNotNull, gte } from "drizzle-orm";
import { fetchTransactionPage, type TransactionRow } from "@/queries/transactions";
import { notDeleted } from "@/lib/query-helpers";
import { db as defaultDb, type LedgrDb } from "@/db";
import { recurringTransactions, merchants, categories, accounts, transactions } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { detectSubscriptionCandidates, type SubscriptionSuggestion } from "@/lib/recurring-suggestions";
import { matchesRules, type MatchRules } from "@/lib/recurring-match";
import { deriveBillStatus, relativeDateLabel, todayDateString, type BillStatus } from "@/lib/date-utils";

export interface BillRow {
  id: string;
  name: string;
  merchantName: string | null;
  categoryName: string | null;
  categoryIcon: string | null;
  averageAmount: number | null;
  lastAmount: number | null;
  frequency: string | null;
  nextDate: string | null;
  lastDate: string | null;
  isIncome: boolean;
  status: BillStatus;
  relativeDateLabel: string | null;
}

export async function getUpcomingBills(
  householdId: string,
  opts: { search?: string; limit?: number } = {},
  db: LedgrDb = defaultDb,
): Promise<BillRow[]> {
  const scoped = scopedQuery(householdId, db);

  const conditions = [
    eq(recurringTransactions.isActive, true),
    eq(recurringTransactions.status, "active"),
    eq(recurringTransactions.isIncome, false),
  ];

  if (opts.search) {
    conditions.push(ilike(recurringTransactions.name, `%${opts.search}%`));
  }

  let builder = db
    .select({
      id: recurringTransactions.id,
      name: recurringTransactions.name,
      merchantName: merchants.name,
      categoryName: categories.name,
      categoryIcon: categories.icon,
      averageAmount: recurringTransactions.averageAmount,
      lastAmount: recurringTransactions.lastAmount,
      frequency: recurringTransactions.frequency,
      nextDate: recurringTransactions.nextDate,
      lastDate: recurringTransactions.lastDate,
      isIncome: recurringTransactions.isIncome,
    })
    .from(recurringTransactions)
    .leftJoin(merchants, eq(recurringTransactions.merchantId, merchants.id))
    .leftJoin(categories, eq(recurringTransactions.categoryId, categories.id))
    .where(scoped.where(recurringTransactions, ...conditions))
    .orderBy(asc(recurringTransactions.nextDate));

  if (opts.limit) {
    builder = builder.limit(opts.limit) as typeof builder;
  }

  const rows = await builder;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    merchantName: row.merchantName,
    categoryName: row.categoryName,
    categoryIcon: row.categoryIcon,
    averageAmount: row.averageAmount ? Math.abs(row.averageAmount) : null,
    lastAmount: row.lastAmount ? Math.abs(row.lastAmount) : null,
    frequency: row.frequency,
    nextDate: row.nextDate,
    lastDate: row.lastDate,
    isIncome: Boolean(row.isIncome),
    status: deriveBillStatus(row.nextDate, true),
    relativeDateLabel: row.nextDate ? relativeDateLabel(row.nextDate) : null,
  }));
}

export interface RecurringRow extends BillRow {
  lifecycle: "active" | "paused" | "archived";
  source: "detected" | "manual";
  categoryId: string | null;
  accountId: string | null;
  accountName: string | null;
  isActive: boolean;
  matchName: string | null;
  matchMinAmount: number | null;
  matchMaxAmount: number | null;
  matchDayOfMonth: number | null;
}

export interface RecurringGroups {
  overdue: RecurringRow[];
  thisMonth: RecurringRow[];
  future: RecurringRow[];
  paused: RecurringRow[];
  archived: RecurringRow[];
}

/**
 * Every expense item, bucketed the way the Recurrings page shows them.
 * Archived and user-paused items get their own groups; an item detection
 * considers stopped (`isActive` false) is shown as paused rather than hidden,
 * so the user can still find and archive or revive it.
 */
export async function getRecurrings(
  householdId: string,
  opts: { search?: string } = {},
  db: LedgrDb = defaultDb,
): Promise<RecurringGroups> {
  const scoped = scopedQuery(householdId, db);
  const conditions = [eq(recurringTransactions.isIncome, false)];
  if (opts.search) conditions.push(ilike(recurringTransactions.name, `%${opts.search}%`));

  const rows = await db
    .select({
      id: recurringTransactions.id,
      name: recurringTransactions.name,
      merchantName: merchants.name,
      categoryId: recurringTransactions.categoryId,
      categoryName: categories.name,
      categoryIcon: categories.icon,
      accountId: recurringTransactions.accountId,
      accountName: accounts.name,
      averageAmount: recurringTransactions.averageAmount,
      lastAmount: recurringTransactions.lastAmount,
      frequency: recurringTransactions.frequency,
      nextDate: recurringTransactions.nextDate,
      lastDate: recurringTransactions.lastDate,
      isIncome: recurringTransactions.isIncome,
      isActive: recurringTransactions.isActive,
      status: recurringTransactions.status,
      source: recurringTransactions.source,
      matchName: recurringTransactions.matchName,
      matchMinAmount: recurringTransactions.matchMinAmount,
      matchMaxAmount: recurringTransactions.matchMaxAmount,
      matchDayOfMonth: recurringTransactions.matchDayOfMonth,
    })
    .from(recurringTransactions)
    .leftJoin(merchants, eq(recurringTransactions.merchantId, merchants.id))
    .leftJoin(categories, eq(recurringTransactions.categoryId, categories.id))
    .leftJoin(accounts, eq(recurringTransactions.accountId, accounts.id))
    .where(scoped.where(recurringTransactions, ...conditions))
    .orderBy(asc(recurringTransactions.nextDate));

  const today = todayDateString();
  const month = today.slice(0, 7);
  const groups: RecurringGroups = { overdue: [], thisMonth: [], future: [], paused: [], archived: [] };

  for (const row of rows) {
    const item: RecurringRow = {
      id: row.id,
      name: row.name,
      merchantName: row.merchantName,
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      categoryIcon: row.categoryIcon,
      accountId: row.accountId,
      accountName: row.accountName,
      averageAmount: row.averageAmount ? Math.abs(row.averageAmount) : null,
      lastAmount: row.lastAmount ? Math.abs(row.lastAmount) : null,
      frequency: row.frequency,
      nextDate: row.nextDate,
      lastDate: row.lastDate,
      isIncome: Boolean(row.isIncome),
      isActive: Boolean(row.isActive),
      lifecycle: row.status,
      source: row.source,
      matchName: row.matchName,
      matchMinAmount: row.matchMinAmount,
      matchMaxAmount: row.matchMaxAmount,
      matchDayOfMonth: row.matchDayOfMonth,
      status: deriveBillStatus(row.nextDate, true),
      relativeDateLabel: row.nextDate ? relativeDateLabel(row.nextDate) : null,
    };

    if (row.status === "archived") groups.archived.push(item);
    else if (row.status === "paused" || !row.isActive) groups.paused.push(item);
    else if (row.nextDate && row.nextDate < today) groups.overdue.push(item);
    else if (row.nextDate && row.nextDate.slice(0, 7) === month) groups.thisMonth.push(item);
    else groups.future.push(item);
  }
  return groups;
}

/** Transactions linked to one recurring item, newest first. */
export async function getRecurringTransactions(
  householdId: string,
  recurringId: string,
  db: LedgrDb = defaultDb,
): Promise<TransactionRow[]> {
  const page = await fetchTransactionPage(
    householdId,
    [eq(transactions.recurringTransactionId, recurringId), notDeleted(transactions)],
    200,
    null,
    db,
  );
  return page.rows;
}

/** Recent settled transactions not yet linked to any item, for the panel's "Add". */
export async function getLinkableTransactions(
  householdId: string,
  opts: { search?: string } = {},
  db: LedgrDb = defaultDb,
): Promise<TransactionRow[]> {
  const conditions = [isNull(transactions.recurringTransactionId), notDeleted(transactions), eq(transactions.pending, false)];
  if (opts.search) conditions.push(ilike(transactions.name, `%${opts.search}%`));
  const page = await fetchTransactionPage(householdId, conditions, 25, null, db);
  return page.rows;
}

const MONTHLY_MULTIPLIER: Record<string, number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  semimonthly: 2,
  monthly: 1,
  yearly: 1 / 12,
};

export async function getRecurringSummary(
  householdId: string,
  db: LedgrDb = defaultDb,
): Promise<{ monthlyIncome: number; monthlyExpenses: number }> {
  const scoped = scopedQuery(householdId, db);

  const rows = await db
    .select({
      averageAmount: recurringTransactions.averageAmount,
      frequency: recurringTransactions.frequency,
      isIncome: recurringTransactions.isIncome,
    })
    .from(recurringTransactions)
    .where(
      scoped.where(
        recurringTransactions,
        eq(recurringTransactions.isActive, true),
        eq(recurringTransactions.status, "active"),
      ),
    );

  let monthlyIncome = 0;
  let monthlyExpenses = 0;

  for (const row of rows) {
    if (!row.averageAmount || !row.frequency) continue;
    const multiplier = MONTHLY_MULTIPLIER[row.frequency] ?? 1;
    const monthly = Math.round(Math.abs(row.averageAmount) * multiplier);
    if (row.isIncome) {
      monthlyIncome += monthly;
    } else {
      monthlyExpenses += monthly;
    }
  }

  return { monthlyIncome, monthlyExpenses };
}

export interface RecurringRuleRow {
  id: string;
  name: string;
  matchName: string;
  matchMinAmount: number | null;
  matchMaxAmount: number | null;
  matchDayOfMonth: number | null;
  frequency: string | null;
  lifecycle: "active" | "paused" | "archived";
}

/** Every recurring item that has a match rule, for the Rules page. Archived last. */
export async function getRecurringRules(
  householdId: string,
  db: LedgrDb = defaultDb,
): Promise<RecurringRuleRow[]> {
  const scoped = scopedQuery(householdId, db);
  const rows = await db
    .select({
      id: recurringTransactions.id,
      name: recurringTransactions.name,
      matchName: recurringTransactions.matchName,
      matchMinAmount: recurringTransactions.matchMinAmount,
      matchMaxAmount: recurringTransactions.matchMaxAmount,
      matchDayOfMonth: recurringTransactions.matchDayOfMonth,
      frequency: recurringTransactions.frequency,
      lifecycle: recurringTransactions.status,
    })
    .from(recurringTransactions)
    .where(scoped.where(recurringTransactions, isNotNull(recurringTransactions.matchName)))
    .orderBy(asc(recurringTransactions.name));

  return rows
    .filter((r): r is typeof r & { matchName: string } => !!r.matchName?.trim())
    .sort((a, b) => Number(a.lifecycle === "archived") - Number(b.lifecycle === "archived"));
}

/**
 * Transactions a rule set would claim, for the live preview while the user
 * edits it. Includes ones already linked to this item (flagged) so the list
 * shows the full picture; ones linked elsewhere are left out.
 */
export async function previewRecurringMatches(
  householdId: string,
  recurringId: string,
  rules: MatchRules,
  isIncome = false,
  db: LedgrDb = defaultDb,
): Promise<(TransactionRow & { linked: boolean })[]> {
  const needle = rules.matchName?.trim();
  if (!needle) return [];
  const escaped = needle.replace(/[\\%_]/g, "\\$&");
  const page = await fetchTransactionPage(
    householdId,
    [
      ilike(transactions.name, `%${escaped}%`),
      notDeleted(transactions),
      eq(transactions.pending, false),
      eq(transactions.isTransfer, false),
    ],
    200,
    null,
    db,
  );
  return page.rows
    .filter((r) => !r.recurringTransactionId || r.recurringTransactionId === recurringId)
    .filter((r) => (isIncome ? r.normalizedAmount > 0 : r.normalizedAmount < 0))
    .filter((r) => matchesRules(r, rules))
    .map((r) => ({ ...r, linked: r.recurringTransactionId === recurringId }));
}

/** Repeating charges not yet tracked, for the "Suggested" list. */
export async function getRecurringSuggestions(
  householdId: string,
  db: LedgrDb = defaultDb,
): Promise<SubscriptionSuggestion[]> {
  const scoped = scopedQuery(householdId, db);
  const since = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
  const [page, items] = await Promise.all([
    fetchTransactionPage(
      householdId,
      [
        isNull(transactions.recurringTransactionId),
        notDeleted(transactions),
        eq(transactions.pending, false),
        eq(transactions.isTransfer, false),
        gte(transactions.date, since),
      ],
      3000,
      null,
      db,
    ),
    db
      .select({ name: recurringTransactions.name, matchName: recurringTransactions.matchName })
      .from(recurringTransactions)
      .where(scoped.where(recurringTransactions)),
  ]);
  return detectSubscriptionCandidates(page.rows, items, todayDateString());
}
