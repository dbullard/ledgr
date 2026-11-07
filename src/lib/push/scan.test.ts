import { describe, expect, it } from "vitest";
import {
  billCandidates,
  budgetCandidates,
  connectionCandidates,
  getPushScanSettings,
  isQuietHour,
  largeTxnCandidates,
  lowBalanceCandidates,
  depositCandidates,
  reviewCandidates,
  weeklyCandidates,
} from "./scan";
import type { BillRow } from "@/queries/recurring";
import type { BudgetMonth } from "@/queries/budgets";

const NOW = new Date(2026, 10, 7, 10, 0, 0); // Sat 7 Nov 2026, 10:00 local

function bill(over: Partial<BillRow>): BillRow {
  return {
    id: "r1",
    name: "Netflix",
    merchantName: null,
    categoryName: null,
    categoryIcon: null,
    averageAmount: 1599,
    lastAmount: 1599,
    frequency: "monthly",
    nextDate: "2026-11-08",
    lastDate: null,
    isIncome: false,
    status: "due-soon",
    relativeDateLabel: "Tomorrow",
    ...over,
  };
}

describe("billCandidates", () => {
  it("announces bills due today or tomorrow, once per due date", () => {
    const out = billCandidates(
      [
        bill({ id: "a", nextDate: "2026-11-07", name: "Rent" }),
        bill({ id: "b", nextDate: "2026-11-08" }),
        bill({ id: "c", nextDate: "2026-11-09" }),
        bill({ id: "d", nextDate: "2026-11-05" }),
        bill({ id: "e", nextDate: null }),
        bill({ id: "f", nextDate: "2026-11-08", isIncome: true }),
      ],
      NOW,
    );
    expect(out.map((c) => c.key)).toEqual(["bill:a:2026-11-07", "bill:b:2026-11-08"]);
    expect(out[0].message).toMatchObject({ title: "Bill due today", body: "Rent · $15.99" });
    expect(out[1].message.title).toBe("Bill due tomorrow");
  });

  it("rolls over month ends when working out tomorrow", () => {
    const eom = new Date(2026, 11, 31, 9, 0, 0);
    const out = billCandidates([bill({ nextDate: "2027-01-01" })], eom);
    expect(out).toHaveLength(1);
  });

  it("omits the amount when none is known", () => {
    const [c] = billCandidates([bill({ lastAmount: null, averageAmount: null })], NOW);
    expect(c.message.body).toBe("Netflix");
  });
});

function budget(cats: Array<{ id: string; name: string; limit: number; spent: number }>): BudgetMonth {
  return {
    budget: { id: "b1", month: "2026-11", type: "category" },
    groups: [
      {
        groupId: "g",
        groupName: "G",
        groupIcon: null,
        totalBudgeted: 0,
        totalSpent: 0,
        categories: cats.map((c) => ({
          budgetCategoryId: `bc-${c.id}`,
          categoryId: c.id,
          categoryName: c.name,
          categoryIcon: null,
          limitAmount: c.limit,
          spent: c.spent,
          remaining: c.limit - c.spent,
          isFixed: false,
        })),
      },
    ],
    unbudgeted: { spent: 0, categories: [] },
    summary: { totalBudgeted: 0, totalSpent: 0, totalRemaining: 0 },
    lastSyncedAt: null,
  };
}

describe("budgetCandidates", () => {
  it("fires 80% below the limit and ignores categories under 80%", () => {
    const out = budgetCandidates(
      "2026-11",
      budget([
        { id: "food", name: "Groceries", limit: 50000, spent: 40000 },
        { id: "fun", name: "Fun", limit: 10000, spent: 7999 },
      ]),
    );
    expect(out.map((c) => c.key)).toEqual(["budget:2026-11:food:80"]);
    expect(out[0].message.body).toBe("$400.00 of $500.00 · $100.00 left");
  });

  it("fires 100% and pre-claims 80% so jumping past both sends one alert", () => {
    const [c] = budgetCandidates("2026-11", budget([{ id: "food", name: "Groceries", limit: 50000, spent: 52000 }]));
    expect(c.key).toBe("budget:2026-11:food:100");
    expect(c.alsoClaim).toEqual(["budget:2026-11:food:80"]);
    expect(c.message.title).toBe("Over budget: Groceries");
  });

  it("skips zero limits and months with no budget", () => {
    expect(budgetCandidates("2026-11", budget([{ id: "x", name: "X", limit: 0, spent: 500 }]))).toEqual([]);
    expect(budgetCandidates("2026-11", { ...budget([]), budget: null })).toEqual([]);
  });
});

describe("largeTxnCandidates", () => {
  it("keys on the transaction id", () => {
    const [c] = largeTxnCandidates([{ id: "t9", name: "Best Buy", amount: 129900, date: "2026-11-07" }]);
    expect(c.key).toBe("txn:t9");
    expect(c.message).toMatchObject({ title: "Large charge: $1,299.00", body: "Best Buy" });
  });
});

describe("connectionCandidates", () => {
  const row = (over: object) => ({
    id: "c1",
    institutionName: "Chase",
    status: "reauth_required",
    errorCode: null,
    errorMessage: null,
    ...over,
  });

  it("announces unhealthy connections only", () => {
    const out = connectionCandidates([
      row({}),
      row({ id: "c2", status: "active" }),
      row({ id: "c3", status: "pending_classification" }),
      row({ id: "c4", status: null }),
    ]);
    expect(out.map((c) => c.key)).toEqual(["conn:c1:reauth_required"]);
    expect(out[0].message.title).toContain("Chase");
  });

  it("keys on status so a different failure is announced again", () => {
    const [a] = connectionCandidates([row({ status: "error" })]);
    const [b] = connectionCandidates([row({ status: "revoked" })]);
    expect(a.key).not.toBe(b.key);
  });
});

describe("isQuietHour", () => {
  const s = { quietStartHour: 21, quietEndHour: 8 };
  it("spans midnight", () => {
    expect([0, 7, 21, 23].every((h) => isQuietHour(h, s))).toBe(true);
    expect([8, 12, 20].some((h) => isQuietHour(h, s))).toBe(false);
  });
  it("handles a same-day window and an empty one", () => {
    expect(isQuietHour(13, { quietStartHour: 12, quietEndHour: 14 })).toBe(true);
    expect(isQuietHour(15, { quietStartHour: 12, quietEndHour: 14 })).toBe(false);
    expect(isQuietHour(3, { quietStartHour: 5, quietEndHour: 5 })).toBe(false);
  });
});

describe("getPushScanSettings", () => {
  it("defaults to $250 and 21:00-08:00", () => {
    expect(getPushScanSettings({})).toMatchObject({ largeTxnCents: 25000, quietStartHour: 21, quietEndHour: 8 });
  });
  it("reads overrides and ignores junk", () => {
    expect(getPushScanSettings({ PUSH_LARGE_TXN_CENTS: "10000", PUSH_QUIET_END_HOUR: "7" })).toMatchObject({
      largeTxnCents: 10000,
      quietEndHour: 7,
    });
    expect(getPushScanSettings({ PUSH_LARGE_TXN_CENTS: "abc", PUSH_QUIET_END_HOUR: "99" })).toMatchObject({
      largeTxnCents: 25000,
      quietEndHour: 8,
    });
  });
});

describe("lowBalanceCandidates", () => {
  it("flags balances under the limit, one key per account", () => {
    const out = lowBalanceCandidates(
      [
        { id: "a", name: "Checking", currentBalance: 4_200 },
        { id: "b", name: "Savings", currentBalance: 50_000 },
        { id: "c", name: "Unsynced", currentBalance: null },
        { id: "d", name: "Overdrawn", currentBalance: -1_500 },
      ],
      10_000,
    );
    expect(out.map((c) => c.key)).toEqual(["lowbal:a", "lowbal:d"]);
    expect(out[0].message).toMatchObject({ title: "Low balance: Checking", body: "$42.00 (under $100.00)" });
  });
});

describe("depositCandidates", () => {
  it("announces money in using the absolute amount", () => {
    const [c] = depositCandidates([{ id: "t1", name: "ACME PAYROLL", amount: -245000, date: "2026-11-07" }]);
    expect(c.key).toBe("dep:t1");
    expect(c.message).toMatchObject({ title: "Deposit: $2,450.00", body: "ACME PAYROLL" });
  });
});

describe("reviewCandidates", () => {
  it("needs a pile-up and is keyed per day", () => {
    expect(reviewCandidates(4, NOW)).toEqual([]);
    const [c] = reviewCandidates(7, NOW);
    expect(c.key).toBe("review:2026-11-07");
    expect(c.message.title).toBe("7 transactions need a category");
  });
});

describe("weeklyCandidates", () => {
  const week = { spentCents: 41250, incomeCents: 200000, charges: 18 };
  it("only fires on Sunday from 9am", () => {
    expect(weeklyCandidates(week, NOW)).toEqual([]); // Saturday
    expect(weeklyCandidates(week, new Date(2026, 10, 8, 8, 0))).toEqual([]);
    const [c] = weeklyCandidates(week, new Date(2026, 10, 8, 9, 30));
    expect(c.key).toBe("weekly:2026-11-08");
    expect(c.message.body).toBe("Spent $412.50 across 18 charges · $2,000.00 came in");
  });
});
