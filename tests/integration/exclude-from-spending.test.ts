import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "./setup";
import {
  insertHousehold,
  insertAccount,
  insertCategoryGroup,
  insertCategory,
  insertTransaction,
} from "./helpers";
import type { LedgrDb } from "../../src/db";

/**
 * A category marked `excludeFromSpending` (a spouse's business expenses, say)
 * is left out of every spending figure, whatever else qualifies its rows. The
 * rows themselves stay on the Transactions page.
 */

let db: LedgrDb;
let close: () => Promise<void>;
let householdId: string;
let accountId: string;
let foodCatId: string;
let workCatId: string;

const RANGE = { dateFrom: "2026-03-01", dateTo: "2026-03-31" };

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ({ householdId } = await insertHousehold(db));
  ({ accountId } = await insertAccount(db, householdId));

  const { groupId } = await insertCategoryGroup(db, householdId, { name: "Living" });
  ({ categoryId: foodCatId } = await insertCategory(db, householdId, groupId, { name: "Food" }));
  ({ categoryId: workCatId } = await insertCategory(db, householdId, groupId, {
    name: "Work Expenses",
    excludeFromSpending: true,
  }));

  await insertTransaction(db, householdId, accountId, { date: "2026-03-05", normalizedAmount: -5000, amount: 5000, categoryId: foodCatId, name: "Grocery" });
  await insertTransaction(db, householdId, accountId, { date: "2026-03-06", normalizedAmount: -35000, amount: 35000, categoryId: workCatId, name: "Venmo for work" });
  // A refund of a work expense is excluded with it, not netted against Food.
  await insertTransaction(db, householdId, accountId, { date: "2026-03-07", normalizedAmount: 1000, amount: -1000, categoryId: workCatId, name: "Work refund" });
});

afterEach(async () => {
  await close();
});

describe("a category excluded from spending", () => {
  test("is absent from the Spending tab", async () => {
    const { getSpendingByCategory } = await import("../../src/queries/reports");
    const rows = await getSpendingByCategory(householdId, RANGE, db);

    expect(rows.reduce((s, r) => s + r.total, 0)).toBe(5000);
    expect(rows.find((r) => r.categoryName === "Work Expenses")).toBeUndefined();
  });

  test("is absent from Income vs Expense, its category table, Trends and the Sankey", async () => {
    const { getIncomeVsExpense, getIncomeExpenseByCategory, getCategoryTrends, getCashFlowSankey } =
      await import("../../src/queries/reports");

    expect((await getIncomeVsExpense(householdId, RANGE, db)).reduce((s, r) => s + r.expenses, 0)).toBe(5000);
    expect((await getIncomeExpenseByCategory(householdId, RANGE, db)).some((r) => r.categoryName === "Work Expenses")).toBe(false);
    expect((await getCategoryTrends(householdId, RANGE, db)).reduce((s, r) => s + r.total, 0)).toBe(5000);
    expect((await getCashFlowSankey(householdId, RANGE, db)).nodes.some((n) => n.name === "Work Expenses")).toBe(false);
  });

  test("is absent from the dashboard summary and monthly spending", async () => {
    const { getDashboardSummary, getMonthlySpending } = await import("../../src/queries/dashboard");

    const summary = await getDashboardSummary(householdId, "2026-03", db);
    expect(summary.monthlyExpenses).toBe(5000);
    // The excluded refund must not turn into income either.
    expect(summary.monthlyIncome).toBe(0);

    const spending = await getMonthlySpending(householdId, "2026-03", db);
    expect(spending.map((r) => r.categoryName)).toEqual(["Food"]);
  });

  test("its rows still appear on the Transactions page", async () => {
    const { getTransactions } = await import("../../src/queries/transactions");
    const page = await getTransactions(householdId, {}, 50, null, db);

    expect(page.rows.map((r) => r.name)).toContain("Venmo for work");
  });

  test("counts again once the flag is cleared", async () => {
    const { categories } = await import("../../src/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(categories).set({ excludeFromSpending: false }).where(eq(categories.id, workCatId));

    const { getSpendingByCategory } = await import("../../src/queries/reports");
    const rows = await getSpendingByCategory(householdId, RANGE, db);

    // Food 5000 + Work Expenses (35000 charge less the 1000 refund).
    expect(rows.reduce((s, r) => s + r.total, 0)).toBe(39000);
  });
});
