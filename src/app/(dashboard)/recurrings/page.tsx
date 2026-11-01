import { getHouseholdId } from "@/lib/auth/session";
import { withHousehold } from "@/lib/household-context";
import { getRecurrings, getRecurringSummary, getRecurringTransactions } from "@/queries/recurring";
import { getCategories } from "@/queries/categories";
import { centsToDisplay } from "@/lib/money";
import { RecurringList } from "@/components/organisms/recurring-list";
import { RecurringCreateDialog } from "@/components/organisms/recurring-create-dialog";
import { BillSearch } from "@/components/molecules/bill-search";
import { BillEmptyState } from "@/components/molecules/bill-empty-state";

export default async function RecurringsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const householdId = await getHouseholdId();
  const params = await searchParams;
  const [groups, summary, categoryGroups] = await Promise.all([
    getRecurrings(householdId, { search: params.q }),
    getRecurringSummary(householdId),
    getCategories(householdId),
  ]);

  const all = [...groups.overdue, ...groups.thisMonth, ...groups.future, ...groups.paused, ...groups.archived];
  const item = params.item ? all.find((r) => r.id === params.item) : undefined;
  const selected = item
    ? { item, transactions: await withHousehold(householdId, (tx) => getRecurringTransactions(householdId, item.id, tx)) }
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Recurrings</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {summary.monthlyExpenses > 0 && (
              <span>
                {centsToDisplay(summary.monthlyExpenses)}/mo in recurring expenses
              </span>
            )}
            {summary.monthlyIncome > 0 && summary.monthlyExpenses > 0 && " · "}
            {summary.monthlyIncome > 0 && (
              <span>
                {centsToDisplay(summary.monthlyIncome)}/mo recurring income
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {all.length > 0 && <BillSearch />}
          <RecurringCreateDialog categoryGroups={categoryGroups} />
        </div>
      </div>

      {all.length === 0 ? (
        <BillEmptyState />
      ) : (
        <RecurringList groups={groups} categoryGroups={categoryGroups} selected={selected} />
      )}
    </div>
  );
}
