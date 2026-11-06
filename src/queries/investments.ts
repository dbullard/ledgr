import { eq, and, sql, desc, gte, lte, isNull, inArray } from "drizzle-orm";
import { db as defaultDb, type LedgrDb } from "@/db";
import { investmentHoldings, holdingsHistory, investmentTransactions, accounts, balanceHistory, transactions } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { encodeCursor, decodeCursor, sumCol, countRows } from "@/lib/query-helpers";
import { todayDateString, previousDateString } from "@/lib/date-utils";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PortfolioSummary {
  /** What the accounts are actually worth: their balances, not the holdings sum. */
  totalValue: number;
  /** The itemized part. */
  holdingsValue: number;
  /** totalValue - holdingsValue: real uninvested cash, or value a connector did not itemize. */
  cashValue: number;
  /** Covers only the holdings portion -- it is derived from holdings_history. */
  dayChange: number | null;
  /** Covers only holdings that actually report a cost basis. */
  totalGainLoss: number;
  totalCostBasis: number;
  /** Current value of the holdings the gain/loss figure describes, so the UI can state its scope. */
  gainLossCoverage: number;
}

export interface AccountReconciliationRow {
  accountId: string;
  accountName: string;
  balance: number;
  holdingsValue: number;
  cashValue: number;
  /** False when the connector returned a balance but itemized nothing. */
  hasHoldings: boolean;
  /** True when the connector itself sent holdings (as opposed to a user-set single fund). */
  hasSyncedHoldings: boolean;
  /** Set when the user itemized the whole account as one fund. */
  fundTicker: string | null;
  fundName: string | null;
}

/** An investment account the user says is a single fund, and that the connector did not itemize. */
interface FundAccount {
  id: string;
  name: string;
  balance: number;
  ticker: string;
  fundName: string;
}

export interface BalanceGrowth {
  /** First balance snapshot in the window. */
  since: string;
  startValue: number;
  endValue: number;
  /** Net money moved into the accounts in the window (contributions less withdrawals and fees). */
  netContributions: number;
  /** What the value rose by beyond those contributions -- an estimate, not a return. */
  growth: number;
}

export interface PortfolioPoint {
  date: string;
  value: number;
}

export interface AllocationSlice {
  type: string;
  value: number;
  percentage: number;
}

export interface InvestmentHoldingRow {
  ticker: string | null;
  securityName: string;
  type: string | null;
  sector: string | null;
  quantity: number;
  currentValue: number;
  costBasis: number | null;
  gainLoss: number | null;
  gainLossPercent: number | null;
  accountName?: string;
  accountId?: string;
}

export interface InvestmentsSummaryHolding {
  ticker: string | null;
  securityName: string;
  currentValue: number;
  gainLossPercent: number | null;
  /** Share of total portfolio value, 0-100. */
  share: number;
}

export interface InvestmentsSummary {
  totalValue: number;
  dayChange: number | null;
  holdingCount: number;
  topHoldings: InvestmentsSummaryHolding[];
}

export interface InvTxnRow {
  id: string;
  date: string;
  type: string | null;
  securityName: string | null;
  ticker: string | null;
  quantity: number | null;
  price: number | null;
  amount: number;
  fees: number | null;
  accountName: string;
}

export interface InvTxnPage {
  rows: InvTxnRow[];
  nextCursor: string | null;
}

export interface InvestmentFilters {
  type?: string;
  accountId?: string;
  dateFrom?: string;
  dateTo?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export async function getInvestmentAccountIds(householdId: string, db: LedgrDb = defaultDb): Promise<string[]> {
  const scoped = scopedQuery(householdId, db);
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(scoped.where(accounts, eq(accounts.type, "investment"), isNull(accounts.deletedAt)));
  return rows.map((r) => r.id);
}

function computeGainLoss(
  currentValue: number | null,
  costBasis: number | null,
): { gainLoss: number | null; gainLossPercent: number | null } {
  const cv = currentValue ?? 0;
  if (costBasis === null || currentValue === null) {
    return { gainLoss: null, gainLossPercent: null };
  }
  return {
    gainLoss: cv - costBasis,
    gainLossPercent: costBasis !== 0 ? ((cv - costBasis) / costBasis) * 100 : null,
  };
}

async function resolveAccIds(householdId: string, db: LedgrDb, accIds?: string[]): Promise<string[]> {
  return accIds ?? getInvestmentAccountIds(householdId, db);
}

/** Accounts (among `ids`) that have holdings synced from their connector. */
async function getSyncedHoldingAccountIds(db: LedgrDb, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ accountId: investmentHoldings.accountId })
    .from(investmentHoldings)
    .where(inArray(investmentHoldings.accountId, ids));
  return new Set(rows.map((r) => r.accountId));
}

/**
 * Accounts the user itemized as one fund. Their position is the account
 * balance, so it tracks the balance every sync with no price feed. A connector
 * that does send holdings always wins, so a later real sync supersedes this.
 */
async function getFundAccounts(db: LedgrDb, ids: string[]): Promise<FundAccount[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      balance: accounts.currentBalance,
      ticker: accounts.fundTicker,
      fundName: accounts.fundName,
    })
    .from(accounts)
    .where(and(inArray(accounts.id, ids), sql`${accounts.fundTicker} IS NOT NULL`));
  if (rows.length === 0) return [];
  const synced = await getSyncedHoldingAccountIds(db, rows.map((r) => r.id));
  return rows
    .filter((r) => !synced.has(r.id) && r.balance !== null && r.ticker)
    .map((r) => ({
      id: r.id,
      name: r.name,
      balance: r.balance ?? 0,
      ticker: r.ticker as string,
      fundName: r.fundName?.trim() || (r.ticker as string),
    }));
}

/** Sums per-account series by date, carrying each account's last value forward. */
function mergeSeries(series: Map<string, number>[]): PortfolioPoint[] {
  const dates = [...new Set(series.flatMap((s) => [...s.keys()]))].sort();
  const last = series.map(() => null as number | null);
  return dates.map((date) => {
    let value = 0;
    series.forEach((s, i) => {
      const v = s.get(date);
      if (v !== undefined) last[i] = v;
      value += last[i] ?? 0;
    });
    return { date, value };
  });
}

// ─── Queries ────────────────────────────────────────────────────────────────

export async function getPortfolioSummary(
  householdId: string,
  db: LedgrDb = defaultDb,
  today?: string,
  accIds?: string[],
): Promise<PortfolioSummary> {
  const ids = await resolveAccIds(householdId, db, accIds);
  if (ids.length === 0) {
    return {
      totalValue: 0,
      holdingsValue: 0,
      cashValue: 0,
      dayChange: null,
      totalGainLoss: 0,
      totalCostBasis: 0,
      gainLossCoverage: 0,
    };
  }

  const holdings = await db
    .select({
      currentValue: investmentHoldings.currentValue,
      costBasis: investmentHoldings.costBasis,
    })
    .from(investmentHoldings)
    .where(inArray(investmentHoldings.accountId, ids));

  const fundAccounts = await getFundAccounts(db, ids);
  let holdingsValue = fundAccounts.reduce((sum, f) => sum + f.balance, 0);
  let totalCostBasis = 0;
  // Gain/loss must span the same set on both sides. Adding every holding to
  // the value side while skipping null-basis ones on the cost side reports a
  // holding's entire value as gain -- which is what inflated the total for
  // zero-basis positions like ETH and BTC.
  let gainLossCoverage = 0;
  for (const h of holdings) {
    holdingsValue += h.currentValue ?? 0;
    if (h.costBasis !== null) {
      totalCostBasis += h.costBasis;
      gainLossCoverage += h.currentValue ?? 0;
    }
  }

  // What the accounts are worth comes from their balances. Summing holdings
  // instead silently drops anything the connector did not itemize.
  const balanceRows = await db
    .select({ id: accounts.id, currentBalance: accounts.currentBalance })
    .from(accounts)
    .where(inArray(accounts.id, ids));
  const anyBalanceReported = balanceRows.some((r) => r.currentBalance !== null);
  const balanceTotal = balanceRows.reduce((sum, r) => sum + (r.currentBalance ?? 0), 0);

  // With no balance recorded anywhere, the holdings sum is the best figure we
  // have -- falling back keeps accounts that predate balance capture working.
  const totalValue = anyBalanceReported ? balanceTotal : holdingsValue;
  // Clamped: a stale balance below the holdings sum would otherwise show
  // negative cash, which is never a real state.
  const cashValue = Math.max(0, totalValue - holdingsValue);

  const todayStr = today ?? todayDateString();
  const yesterdayStr = previousDateString(todayStr);

  const [hasToday] = await db
    .select({ id: holdingsHistory.id })
    .from(holdingsHistory)
    .where(and(inArray(holdingsHistory.accountId, ids), eq(holdingsHistory.date, todayStr)))
    .limit(1);

  const [hasYesterday] = await db
    .select({ id: holdingsHistory.id })
    .from(holdingsHistory)
    .where(and(inArray(holdingsHistory.accountId, ids), eq(holdingsHistory.date, yesterdayStr)))
    .limit(1);

  let dayChange: number | null = null;
  if (hasToday && hasYesterday) {
    const [todayTotal] = await db
      .select({ total: sumCol(holdingsHistory.value) })
      .from(holdingsHistory)
      .where(and(inArray(holdingsHistory.accountId, ids), eq(holdingsHistory.date, todayStr)));

    const [yesterdayTotal] = await db
      .select({ total: sumCol(holdingsHistory.value) })
      .from(holdingsHistory)
      .where(and(inArray(holdingsHistory.accountId, ids), eq(holdingsHistory.date, yesterdayStr)));

    dayChange = (todayTotal?.total ?? 0) - (yesterdayTotal?.total ?? 0);
  }

  // A single-fund account has no holdings history; its day change is the
  // change in its balance snapshots.
  if (fundAccounts.length > 0) {
    const fundIds = fundAccounts.map((f) => f.id);
    const balanceOn = async (date: string) => {
      const rows = await db
        .select({ accountId: balanceHistory.accountId, balance: balanceHistory.balance })
        .from(balanceHistory)
        .where(and(inArray(balanceHistory.accountId, fundIds), eq(balanceHistory.date, date)));
      return rows.length === fundIds.length ? rows.reduce((s, r) => s + r.balance, 0) : null;
    };
    const [fundToday, fundYesterday] = await Promise.all([balanceOn(todayStr), balanceOn(yesterdayStr)]);
    if (fundToday !== null && fundYesterday !== null) {
      dayChange = (dayChange ?? 0) + (fundToday - fundYesterday);
    }
  }

  return {
    totalValue,
    holdingsValue,
    cashValue,
    dayChange,
    totalGainLoss: gainLossCoverage - totalCostBasis,
    totalCostBasis,
    gainLossCoverage,
  };
}

/**
 * Per-account balance-versus-holdings reconciliation.
 *
 * Investments derives its headline from holdings alone, so an account that
 * reports a balance but itemizes only part of it loses the difference with
 * nothing on screen to explain the shortfall (#88). This exposes the gap per
 * account so it can be shown as cash/unallocated, and flags accounts that
 * itemized nothing at all -- a connector gap, not a cash position.
 */
export async function getAccountReconciliation(
  householdId: string,
  db: LedgrDb = defaultDb,
  accIds?: string[],
): Promise<AccountReconciliationRow[]> {
  const ids = await resolveAccIds(householdId, db, accIds);
  if (ids.length === 0) return [];

  const accountRows = await db
    .select({ id: accounts.id, name: accounts.name, currentBalance: accounts.currentBalance })
    .from(accounts)
    .where(inArray(accounts.id, ids));

  const holdingRows = await db
    .select({
      accountId: investmentHoldings.accountId,
      value: sumCol(investmentHoldings.currentValue),
      count: countRows(),
    })
    .from(investmentHoldings)
    .where(inArray(investmentHoldings.accountId, ids))
    .groupBy(investmentHoldings.accountId);

  const byAccount = new Map(holdingRows.map((r) => [r.accountId, r]));
  const fundRows = await db
    .select({ id: accounts.id, ticker: accounts.fundTicker, fundName: accounts.fundName })
    .from(accounts)
    .where(inArray(accounts.id, ids));
  const fundById = new Map(fundRows.map((r) => [r.id, r]));
  const activeFunds = new Map((await getFundAccounts(db, ids)).map((f) => [f.id, f]));

  return accountRows
    .map((a) => {
      const h = byAccount.get(a.id);
      const fund = activeFunds.get(a.id);
      // A user-set single fund is worth the balance by definition.
      const holdingsValue = fund ? fund.balance : (h?.value ?? 0);
      const balance = a.currentBalance ?? holdingsValue;
      const setFund = fundById.get(a.id);
      return {
        accountId: a.id,
        accountName: a.name,
        balance,
        holdingsValue,
        cashValue: Math.max(0, balance - holdingsValue),
        hasHoldings: (h?.count ?? 0) > 0 || !!fund,
        hasSyncedHoldings: (h?.count ?? 0) > 0,
        fundTicker: setFund?.ticker ?? null,
        fundName: setFund?.fundName ?? null,
      };
    })
    .sort((x, y) => y.balance - x.balance);
}

export async function getPortfolioHistory(
  householdId: string,
  dateRange: { dateFrom: string; dateTo: string },
  db: LedgrDb = defaultDb,
  accIds?: string[],
): Promise<PortfolioPoint[]> {
  const ids = await resolveAccIds(householdId, db, accIds);
  if (ids.length === 0) return [];

  const holdingsSeries = await db
    .select({
      accountId: holdingsHistory.accountId,
      date: holdingsHistory.date,
      value: sumCol(holdingsHistory.value),
    })
    .from(holdingsHistory)
    .where(and(
      inArray(holdingsHistory.accountId, ids),
      gte(holdingsHistory.date, dateRange.dateFrom),
      lte(holdingsHistory.date, dateRange.dateTo),
    ))
    .groupBy(holdingsHistory.accountId, holdingsHistory.date);

  // Accounts with no holdings history (a balance-only connector) are charted
  // from their daily balance snapshots instead, so they are not missing from
  // the portfolio line altogether.
  const withHoldings = new Set(holdingsSeries.map((r) => r.accountId));
  const balanceOnlyIds = ids.filter((id) => !withHoldings.has(id));
  const balanceSeries = balanceOnlyIds.length === 0
    ? []
    : await db
        .select({
          accountId: balanceHistory.accountId,
          date: balanceHistory.date,
          value: balanceHistory.balance,
        })
        .from(balanceHistory)
        .where(and(
          inArray(balanceHistory.accountId, balanceOnlyIds),
          gte(balanceHistory.date, dateRange.dateFrom),
          lte(balanceHistory.date, dateRange.dateTo),
        ));

  const byAccount = new Map<string, Map<string, number>>();
  for (const r of [...holdingsSeries, ...balanceSeries]) {
    const series = byAccount.get(r.accountId) ?? new Map<string, number>();
    series.set(r.date, r.value);
    byAccount.set(r.accountId, series);
  }

  // Holdings-only households keep the plain per-date sum. Carrying values
  // forward is only needed once accounts with different snapshot dates are
  // combined into one line.
  if (balanceSeries.length === 0) {
    const sums = new Map<string, number>();
    for (const r of holdingsSeries) sums.set(r.date, (sums.get(r.date) ?? 0) + r.value);
    return [...sums.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({ date, value }));
  }
  return mergeSeries([...byAccount.values()]);
}

/**
 * How much the balance-only accounts grew beyond what was put in. Only an
 * estimate: it is the change in balance over the window, less net money moved
 * into the accounts in that time (the contribution rows Ledgr has recorded).
 * The window never starts before the first recorded transaction. Null until
 * there are at least two balance snapshots to compare.
 *
 * Reads `transactions`, which has row-level security: call it inside
 * `withHousehold`, or it sees no contributions at all.
 */
export async function getBalanceGrowth(
  householdId: string,
  dateRange: { dateFrom: string; dateTo: string },
  db: LedgrDb = defaultDb,
  accIds?: string[],
): Promise<BalanceGrowth | null> {
  const ids = await resolveAccIds(householdId, db, accIds);
  if (ids.length === 0) return null;

  const synced = await getSyncedHoldingAccountIds(db, ids);
  const balanceOnlyIds = ids.filter((id) => !synced.has(id));
  if (balanceOnlyIds.length === 0) return null;

  const rows = await db
    .select({ accountId: balanceHistory.accountId, date: balanceHistory.date, balance: balanceHistory.balance })
    .from(balanceHistory)
    .where(and(
      inArray(balanceHistory.accountId, balanceOnlyIds),
      gte(balanceHistory.date, dateRange.dateFrom),
      lte(balanceHistory.date, dateRange.dateTo),
    ))
    .orderBy(balanceHistory.date);

  const perAccount = new Map<string, { date: string; balance: number }[]>();
  for (const r of rows) {
    const list = perAccount.get(r.accountId) ?? [];
    list.push({ date: r.date, balance: r.balance });
    perAccount.set(r.accountId, list);
  }

  let since: string | null = null;
  let startValue = 0;
  let endValue = 0;
  let netContributions = 0;
  let usable = 0;
  const scoped = scopedQuery(householdId, db);
  for (const [accountId, points] of perAccount) {
    if (points.length < 2) continue;
    const last = points[points.length - 1];

    // Growth is only meaningful where the money moved in is known. Balance
    // history can reach back further than Ledgr's transactions do (a backfill,
    // or a connector that only sent recent rows), and every contribution from
    // before the first recorded transaction would be miscounted as growth. So
    // the window starts at the last snapshot before the first recorded
    // transaction, when one exists.
    const [firstTx] = await db
      .select({ date: sql<string | null>`MIN(${transactions.date})` })
      .from(transactions)
      .where(scoped.where(transactions, eq(transactions.accountId, accountId), isNull(transactions.deletedAt)));
    const earliestTx = firstTx?.date ?? null;

    let start = points[0];
    let flowsFrom = (d: string) => sql`${transactions.date} > ${d}`;
    if (earliestTx && earliestTx > points[0].date) {
      const before = points.filter((p) => p.date < earliestTx);
      start = before[before.length - 1];
      // The snapshot is from before the first transaction, so that day's own
      // transactions are not in it.
      flowsFrom = () => sql`${transactions.date} >= ${earliestTx}`;
    }
    if (start.date >= last.date) continue;
    usable++;
    startValue += start.balance;
    endValue += last.balance;
    if (since === null || start.date < since) since = start.date;

    const [flows] = await db
      .select({ total: sumCol(transactions.normalizedAmount) })
      .from(transactions)
      .where(scoped.where(
        transactions,
        eq(transactions.accountId, accountId),
        isNull(transactions.deletedAt),
        flowsFrom(start.date),
        lte(transactions.date, last.date),
      ));
    netContributions += flows?.total ?? 0;
  }

  if (usable === 0 || since === null) return null;
  return {
    since,
    startValue,
    endValue,
    netContributions,
    growth: endValue - startValue - netContributions,
  };
}

export async function getAssetAllocation(
  householdId: string,
  db: LedgrDb = defaultDb,
  accIds?: string[],
): Promise<AllocationSlice[]> {
  const ids = await resolveAccIds(householdId, db, accIds);
  if (ids.length === 0) return [];

  const rows = await db
    .select({
      type: investmentHoldings.type,
      value: sumCol(investmentHoldings.currentValue),
    })
    .from(investmentHoldings)
    .where(inArray(investmentHoldings.accountId, ids))
    .groupBy(investmentHoldings.type);

  const byType = new Map<string, number>();
  for (const r of rows) byType.set(r.type ?? "other", (byType.get(r.type ?? "other") ?? 0) + (r.value ?? 0));
  // A single-fund account is a mutual fund, worth its balance.
  for (const f of await getFundAccounts(db, ids)) {
    byType.set("mutual_fund", (byType.get("mutual_fund") ?? 0) + f.balance);
  }

  const total = [...byType.values()].reduce((sum, v) => sum + v, 0);

  return [...byType.entries()].map(([type, value]) => ({
    type,
    value,
    percentage: total > 0 ? (value / total) * 100 : 0,
  }));
}

export async function getHoldings(
  householdId: string,
  view: "consolidated" | "by-account",
  accountId: string | undefined,
  db: LedgrDb = defaultDb,
  accIds?: string[],
): Promise<InvestmentHoldingRow[]> {
  const allAccIds = await resolveAccIds(householdId, db, accIds);
  const filteredAccIds = accountId ? allAccIds.filter((id) => id === accountId) : allAccIds;
  if (filteredAccIds.length === 0) return [];

  // Single-fund accounts add one position each, worth the account balance.
  const fundAccounts = await getFundAccounts(db, filteredAccIds);

  if (view === "consolidated") {
    const rows = await db
      .select({
        ticker: investmentHoldings.ticker,
        securityName: investmentHoldings.securityName,
        type: sql<string | null>`MIN(${investmentHoldings.type})`,
        sector: sql<string | null>`MIN(${investmentHoldings.sector})`,
        quantity: sumCol(investmentHoldings.quantity),
        currentValue: sumCol(investmentHoldings.currentValue),
        costBasis: sumCol(investmentHoldings.costBasis),
      })
      .from(investmentHoldings)
      .where(inArray(investmentHoldings.accountId, filteredAccIds))
      .groupBy(investmentHoldings.ticker, investmentHoldings.securityName)
      .orderBy(sql`SUM(${investmentHoldings.currentValue}) DESC`);

    const result: InvestmentHoldingRow[] = rows.map((r) => ({
      ticker: r.ticker,
      securityName: r.securityName,
      type: r.type,
      sector: r.sector,
      quantity: r.quantity ?? 0,
      currentValue: r.currentValue ?? 0,
      costBasis: r.costBasis,
      ...computeGainLoss(r.currentValue, r.costBasis),
    }));
    for (const f of fundAccounts) {
      const existing = result.find((h) => h.ticker === f.ticker && h.securityName === f.fundName);
      if (existing) {
        existing.currentValue += f.balance;
      } else {
        result.push({
          ticker: f.ticker,
          securityName: f.fundName,
          type: "mutual_fund",
          sector: null,
          quantity: 0,
          currentValue: f.balance,
          costBasis: null,
          gainLoss: null,
          gainLossPercent: null,
        });
      }
    }
    return result.sort((a, b) => b.currentValue - a.currentValue);
  }

  const rows = await db
    .select({
      ticker: investmentHoldings.ticker,
      securityName: investmentHoldings.securityName,
      type: investmentHoldings.type,
      sector: investmentHoldings.sector,
      quantity: investmentHoldings.quantity,
      currentValue: investmentHoldings.currentValue,
      costBasis: investmentHoldings.costBasis,
      accountName: accounts.name,
      accountId: investmentHoldings.accountId,
    })
    .from(investmentHoldings)
    .innerJoin(accounts, eq(investmentHoldings.accountId, accounts.id))
    .where(inArray(investmentHoldings.accountId, filteredAccIds))
    .orderBy(sql`${investmentHoldings.currentValue} DESC`);

  const result: InvestmentHoldingRow[] = rows.map((r) => ({
    ticker: r.ticker,
    securityName: r.securityName,
    type: r.type,
    sector: r.sector,
    quantity: r.quantity ?? 0,
    currentValue: r.currentValue ?? 0,
    costBasis: r.costBasis,
    ...computeGainLoss(r.currentValue, r.costBasis),
    accountName: r.accountName,
    accountId: r.accountId,
  }));
  for (const f of fundAccounts) {
    result.push({
      ticker: f.ticker,
      securityName: f.fundName,
      type: "mutual_fund",
      sector: null,
      quantity: 0,
      currentValue: f.balance,
      costBasis: null,
      gainLoss: null,
      gainLossPercent: null,
      accountName: f.name,
      accountId: f.id,
    });
  }
  return result.sort((a, b) => b.currentValue - a.currentValue);
}

export async function getInvestmentTransactions(
  householdId: string,
  filters: InvestmentFilters = {},
  limit = 50,
  cursor: string | null = null,
  db: LedgrDb = defaultDb,
  accIds?: string[],
): Promise<InvTxnPage> {
  const allAccIds = await resolveAccIds(householdId, db, accIds);
  const filteredAccIds = filters.accountId
    ? allAccIds.filter((id) => id === filters.accountId)
    : allAccIds;
  if (filteredAccIds.length === 0) return { rows: [], nextCursor: null };

  const conditions: ReturnType<typeof eq>[] = [
    inArray(investmentTransactions.accountId, filteredAccIds) as ReturnType<typeof eq>,
  ];

  if (filters.type)
    conditions.push(
      eq(investmentTransactions.type, filters.type as "buy" | "sell" | "dividend" | "transfer" | "fee" | "other"),
    );
  if (filters.dateFrom) conditions.push(gte(investmentTransactions.date, filters.dateFrom) as ReturnType<typeof eq>);
  if (filters.dateTo) conditions.push(lte(investmentTransactions.date, filters.dateTo) as ReturnType<typeof eq>);

  const decoded = cursor ? decodeCursor(cursor) : null;
  if (decoded) {
    conditions.push(
      sql`(${investmentTransactions.date} < ${decoded.date} OR (${investmentTransactions.date} = ${decoded.date} AND ${investmentTransactions.id} < ${decoded.id}))` as ReturnType<typeof eq>,
    );
  }

  const rows = await db
    .select({
      id: investmentTransactions.id,
      date: investmentTransactions.date,
      type: investmentTransactions.type,
      securityName: investmentTransactions.securityName,
      ticker: investmentTransactions.ticker,
      quantity: investmentTransactions.quantity,
      price: investmentTransactions.price,
      amount: investmentTransactions.amount,
      fees: investmentTransactions.fees,
      accountName: accounts.name,
    })
    .from(investmentTransactions)
    .innerJoin(accounts, eq(investmentTransactions.accountId, accounts.id))
    .where(and(...conditions))
    .orderBy(desc(investmentTransactions.date), desc(investmentTransactions.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const nextCursor = hasMore
    ? encodeCursor(
        pageRows[pageRows.length - 1].date,
        pageRows[pageRows.length - 1].id,
      )
    : null;

  return { rows: pageRows, nextCursor };
}

export async function getInvestmentsSummary(
  householdId: string,
  db: LedgrDb = defaultDb,
): Promise<InvestmentsSummary> {
  const [summary, holdings] = await Promise.all([
    getPortfolioSummary(householdId, db),
    getHoldings(householdId, "consolidated", undefined, db),
  ]);

  // getHoldings returns consolidated positions already ordered by value, so the
  // dashboard widget just takes the head of the list. Anything past the top few
  // does not fit the cell and belongs on /investments.
  const topHoldings = holdings.slice(0, 3).map((h) => ({
    ticker: h.ticker,
    securityName: h.securityName,
    currentValue: h.currentValue,
    gainLossPercent: h.gainLossPercent,
    share: summary.totalValue > 0 ? (h.currentValue / summary.totalValue) * 100 : 0,
  }));

  return {
    totalValue: summary.totalValue,
    dayChange: summary.dayChange,
    holdingCount: holdings.length,
    topHoldings,
  };
}
