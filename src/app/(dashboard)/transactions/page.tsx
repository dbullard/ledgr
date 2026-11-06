import { getHouseholdId } from "@/lib/auth/session";
import { withHousehold } from "@/lib/household-context";
import {
  getTransactions,
  getTransactionSummary,
  getSuggestedTransfers,
  getTransactionTrend,
  type TrendGranularity,
} from "@/queries/transactions";
import { getCategories } from "@/queries/categories";
import { getAccounts } from "@/queries/accounts";
import { parseTransactionFilters } from "@/lib/parse-transaction-filters";
import { trendBucketBounds, trendBucketLabel } from "@/lib/trend-bucket";
import { BucketFilterChip } from "@/components/molecules/bucket-filter-chip";
import { TransactionFilters as FilterBar } from "@/components/organisms/transaction-filters";
import { TransactionTrendChart } from "@/components/organisms/transaction-trend-chart";
import { FilterSummaryBar } from "@/components/molecules/filter-summary-bar";
import { ReviewEntryButton } from "@/components/molecules/review-entry-button";
import { TransactionList } from "@/components/organisms/transaction-list";
import { TransactionEmptyState } from "@/components/molecules/transaction-empty-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { EyeOff } from "lucide-react";

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const householdId = await getHouseholdId();
  const params = await searchParams;
  const { filters } = parseTransactionFilters(params);
  const by: TrendGranularity =
    params.by === "week" || params.by === "year" || params.by === "5y" ? params.by : "month";

  // A bar clicked on the trend chart narrows the list and summary to that
  // bucket, but not the chart itself, which keeps showing every bucket so the
  // clicked one stays highlighted among its neighbours.
  const bucketKey = typeof params.bucket === "string" ? params.bucket : undefined;
  const bucket = bucketKey ? trendBucketBounds(bucketKey, by) : null;
  const listFilters = bucket ? { ...filters, dateFrom: bucket.from, dateTo: bucket.to } : filters;

  const hasAnyFilters = Object.entries(listFilters)
    .filter(([k]) => k !== "reviewed" && k !== "hidden")
    .some(([, v]) => v !== undefined);

  const [page, allCategories, allAccounts, summary, trend, unreviewedSummary, suggestedTransfers] = await Promise.all([
    withHousehold(householdId, (tx) => getTransactions(householdId, listFilters, undefined, undefined, tx)),
    getCategories(householdId),
    getAccounts(householdId),
    // Always summarised, not only when a filter is applied. The unfiltered view
    // is the one people land on, and it was the only view of the ledger with no
    // arithmetic on it at all — per-day subtotals, and nothing for the whole.
    withHousehold(householdId, (tx) => getTransactionSummary(householdId, listFilters, tx)),
    withHousehold(householdId, (tx) => getTransactionTrend(householdId, filters, by, tx)),
    withHousehold(householdId, (tx) => getTransactionSummary(householdId, { needsReview: true }, tx)),
    withHousehold(householdId, (tx) => getSuggestedTransfers(householdId, tx)),
  ]);
  const accountOptions = allAccounts.map((a) => ({ id: a.id, name: a.name }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Transactions</h1>
        <ReviewEntryButton unreviewedCount={unreviewedSummary.count} />
      </div>

      <FilterBar
        accounts={accountOptions}
        categories={allCategories}
        resultCount={summary?.count ?? 0}
      />

      {filters.hidden && (
        <Alert>
          <EyeOff />
          <AlertTitle>Hidden transactions</AlertTitle>
          <AlertDescription>
            These transactions are excluded from the regular ledger. Use Unhide to restore one.
          </AlertDescription>
        </Alert>
      )}
      {summary && (
        <FilterSummaryBar
          count={summary.count}
          totalExpense={summary.totalExpense}
          totalIncome={summary.totalIncome}
          net={summary.net}
          firstDate={summary.firstDate}
          lastDate={summary.lastDate}
          largestExpense={summary.largestExpense}
          pendingCount={summary.pendingCount}
          pendingAmount={summary.pendingAmount}
          transferCount={summary.transferCount}
          transferAmount={summary.transferAmount}
        />
      )}

      <TransactionTrendChart data={trend} granularity={by} selected={bucket ? bucketKey : undefined} />

      {bucket && bucketKey && <BucketFilterChip label={trendBucketLabel(bucketKey, by, true)} />}

      {page.rows.length === 0 && suggestedTransfers.length === 0 ? (
        <TransactionEmptyState hasFilters={hasAnyFilters} />
      ) : (
        <TransactionList
          key={JSON.stringify(listFilters)}
          initialRows={page.rows}
          nextCursor={page.nextCursor}
          categories={allCategories}
          filters={listFilters}
          suggestedTransfers={suggestedTransfers}
        />
      )}
    </div>
  );
}
