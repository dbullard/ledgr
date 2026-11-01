import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "./setup";
import {
  insertHousehold,
  insertRecurringTransaction,
} from "./helpers";
import type { LedgrDb } from "../../src/db";

let db: LedgrDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

describe("getUpcomingBills", () => {
  it("returns active outflows sorted by nextDate", async () => {
    const { householdId } = await insertHousehold(db);

    await insertRecurringTransaction(db, householdId, {
      name: "Netflix",
      nextDate: "2026-05-15",
      isActive: true,
      isIncome: false,
      averageAmount: 1599,
      frequency: "monthly",
    });
    await insertRecurringTransaction(db, householdId, {
      name: "Gym",
      nextDate: "2026-05-10",
      isActive: true,
      isIncome: false,
      averageAmount: 2500,
      frequency: "monthly",
    });
    await insertRecurringTransaction(db, householdId, {
      name: "Salary",
      nextDate: "2026-05-01",
      isActive: true,
      isIncome: true,
      averageAmount: -300000,
      frequency: "monthly",
    });
    await insertRecurringTransaction(db, householdId, {
      name: "Old Service",
      nextDate: "2026-05-01",
      isActive: false,
      isIncome: false,
    });

    const { getUpcomingBills } = await import("../../src/queries/recurring");
    const bills = await getUpcomingBills(householdId, {}, db);

    expect(bills).toHaveLength(2);
    expect(bills[0].name).toBe("Gym");
    expect(bills[1].name).toBe("Netflix");
  });

  it("filters by search term", async () => {
    const { householdId } = await insertHousehold(db);

    await insertRecurringTransaction(db, householdId, {
      name: "Netflix",
      nextDate: "2026-05-15",
      isActive: true,
      isIncome: false,
    });
    await insertRecurringTransaction(db, householdId, {
      name: "Gym",
      nextDate: "2026-05-10",
      isActive: true,
      isIncome: false,
    });

    const { getUpcomingBills } = await import("../../src/queries/recurring");
    const bills = await getUpcomingBills(householdId, { search: "net" }, db);

    expect(bills).toHaveLength(1);
    expect(bills[0].name).toBe("Netflix");
  });
});

describe("getRecurringSummary", () => {
  it("normalizes amounts to monthly using exact fractions", async () => {
    const { householdId } = await insertHousehold(db);

    await insertRecurringTransaction(db, householdId, {
      name: "Weekly Coffee",
      averageAmount: 1000,
      frequency: "weekly",
      isActive: true,
      isIncome: false,
    });
    await insertRecurringTransaction(db, householdId, {
      name: "Salary",
      averageAmount: 300000,
      frequency: "monthly",
      isActive: true,
      isIncome: true,
    });
    await insertRecurringTransaction(db, householdId, {
      name: "Annual Sub",
      averageAmount: 12000,
      frequency: "yearly",
      isActive: true,
      isIncome: false,
    });

    const { getRecurringSummary } = await import("../../src/queries/recurring");
    const summary = await getRecurringSummary(householdId, db);

    expect(summary.monthlyIncome).toBe(300000);
    expect(summary.monthlyExpenses).toBe(Math.round(1000 * (52 / 12)) + 1000);
  });
});

describe("getRecurrings", () => {
  function shift(days: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function nextMonthStart(): string {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  }

  it("groups by lifecycle and date, expenses only", async () => {
    const { householdId } = await insertHousehold(db);
    const mk = (name: string, over: Record<string, unknown> = {}) =>
      insertRecurringTransaction(db, householdId, { name, isActive: true, isIncome: false, averageAmount: 1000, frequency: "monthly", ...over });

    await mk("Late", { nextDate: shift(-1) });
    await mk("Later", { nextDate: nextMonthStart() });
    await mk("Gone", { nextDate: shift(5), status: "archived" });
    await mk("Held", { nextDate: shift(5), status: "paused" });
    await mk("Stopped", { nextDate: shift(5), isActive: false });
    await mk("Salary", { nextDate: shift(5), isIncome: true });

    const { getRecurrings } = await import("../../src/queries/recurring");
    const groups = await getRecurrings(householdId, {}, db);

    const names = (rows: { name: string }[]) => rows.map((r) => r.name);
    expect(names(groups.overdue)).toEqual(["Late"]);
    expect(names(groups.future)).toEqual(["Later"]);
    expect(names(groups.archived)).toEqual(["Gone"]);
    expect(names(groups.paused).sort()).toEqual(["Held", "Stopped"]);
    expect([...names(groups.overdue), ...names(groups.thisMonth), ...names(groups.future)]).not.toContain("Salary");
  });

  it("puts an item due today in this month, not overdue", async () => {
    const { householdId } = await insertHousehold(db);
    await insertRecurringTransaction(db, householdId, { name: "Today", nextDate: shift(0), isActive: true, isIncome: false });

    const { getRecurrings } = await import("../../src/queries/recurring");
    const groups = await getRecurrings(householdId, {}, db);

    expect(groups.overdue).toHaveLength(0);
    expect(groups.thisMonth.map((r) => r.name)).toEqual(["Today"]);
  });
});

describe("getUpcomingBills with status", () => {
  it("excludes paused and archived items", async () => {
    const { householdId } = await insertHousehold(db);
    await insertRecurringTransaction(db, householdId, { name: "Held", nextDate: "2026-05-10", status: "paused", isActive: true });
    await insertRecurringTransaction(db, householdId, { name: "Gone", nextDate: "2026-05-10", status: "archived", isActive: true });
    await insertRecurringTransaction(db, householdId, { name: "Live", nextDate: "2026-05-10", isActive: true });

    const { getUpcomingBills } = await import("../../src/queries/recurring");
    expect((await getUpcomingBills(householdId, {}, db)).map((b) => b.name)).toEqual(["Live"]);
  });
});

describe("getRecurringTransactions", () => {
  it("returns only that item's transactions, scoped to the household", async () => {
    const { insertAccount, insertTransaction } = await import("./helpers");
    const { householdId } = await insertHousehold(db);
    const other = await insertHousehold(db, "Other");
    const { accountId } = await insertAccount(db, householdId);
    const { accountId: otherAccount } = await insertAccount(db, other.householdId);
    const { recurringId } = await insertRecurringTransaction(db, householdId, { name: "AT&T" });
    await insertTransaction(db, householdId, accountId, { name: "AT&T", date: "2026-09-19", recurringTransactionId: recurringId });
    await insertTransaction(db, householdId, accountId, { name: "AT&T", date: "2026-10-19", recurringTransactionId: recurringId });
    await insertTransaction(db, householdId, accountId, { name: "Other thing" });
    await insertTransaction(db, other.householdId, otherAccount, { name: "AT&T", recurringTransactionId: recurringId });

    const { getRecurringTransactions } = await import("../../src/queries/recurring");
    const rows = await getRecurringTransactions(householdId, recurringId, db);

    expect(rows.map((r) => r.date)).toEqual(["2026-10-19", "2026-09-19"]);
  });
});
