import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";
import {
  insertHousehold,
  insertAccount,
  insertTransaction,
  insertCategoryGroup,
  insertCategory,
  insertBudget,
  insertBudgetCategory,
} from "./helpers";
import { getTransactions } from "../../src/queries/transactions";
import { getBudgetForMonth } from "../../src/queries/budgets";
import { accounts } from "../../src/db/schema";
import type { LedgrDb } from "../../src/db";

// The same bank account linked through two logins shows up twice. Hiding one copy
// must keep its transactions out of lists and budgets, not just out of balances.
describe("transactions in hidden accounts", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;
  let householdId: string;
  let visibleAccountId: string;
  let hiddenAccountId: string;
  let diningCatId: string;
  const month = "2026-03";

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    ({ householdId } = await insertHousehold(db));
    ({ accountId: visibleAccountId } = await insertAccount(db, householdId, { name: "Joint Arvest Checking" }));
    ({ accountId: hiddenAccountId } = await insertAccount(db, householdId, { name: "JOINT", isHidden: true }));
    const { groupId } = await insertCategoryGroup(db, householdId, { name: "Food & Drink" });
    ({ categoryId: diningCatId } = await insertCategory(db, householdId, groupId, { name: "Dining" }));
    const { budgetId } = await insertBudget(db, householdId, { month });
    await insertBudgetCategory(db, budgetId, diningCatId, { limitAmount: 20000 });

    for (const accountId of [visibleAccountId, hiddenAccountId]) {
      await insertTransaction(db, householdId, accountId, {
        date: "2026-03-10",
        name: "Slim Chickens",
        amount: 1244,
        normalizedAmount: -1244,
        categoryId: diningCatId,
      });
    }
  });

  afterAll(async () => {
    await close();
  });

  it("leaves a hidden account's transactions out of the transaction list", async () => {
    const page = await getTransactions(householdId, {}, 50, null, db);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].accountId).toBe(visibleAccountId);
  });

  it("does not count a hidden account's transactions toward budget spending", async () => {
    const result = await getBudgetForMonth(householdId, month, db);
    const dining = result.groups.flatMap((g) => g.categories).find((c) => c.categoryId === diningCatId);
    expect(dining?.spent).toBe(1244);
  });

  it("counts them again once the account is unhidden", async () => {
    await db.update(accounts).set({ isHidden: false }).where(eq(accounts.id, hiddenAccountId));
    try {
      const page = await getTransactions(householdId, {}, 50, null, db);
      expect(page.rows).toHaveLength(2);
      const result = await getBudgetForMonth(householdId, month, db);
      const dining = result.groups.flatMap((g) => g.categories).find((c) => c.categoryId === diningCatId);
      expect(dining?.spent).toBe(2488);
    } finally {
      await db.update(accounts).set({ isHidden: true }).where(eq(accounts.id, hiddenAccountId));
    }
  });
});
