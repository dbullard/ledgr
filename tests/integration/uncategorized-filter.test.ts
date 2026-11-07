import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb } from "./setup";
import { insertHousehold, insertAccount, insertTransaction, insertCategoryGroup, insertCategory } from "./helpers";
import { getTransactions } from "../../src/queries/transactions";
import type { LedgrDb } from "../../src/db";

describe("uncategorized transaction filter", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;
  let householdId: string;
  let accountId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    ({ householdId } = await insertHousehold(db));
    ({ accountId } = await insertAccount(db, householdId));
    const { groupId } = await insertCategoryGroup(db, householdId);
    const { categoryId } = await insertCategory(db, householdId, groupId);
    const base = { date: "2026-03-10", amount: 1000, normalizedAmount: -1000 };
    await insertTransaction(db, householdId, accountId, { ...base, name: "Categorized", categoryId });
    await insertTransaction(db, householdId, accountId, { ...base, name: "No category" });
    await insertTransaction(db, householdId, accountId, { ...base, name: "A transfer", isTransfer: true });
  });

  afterAll(async () => {
    await close();
  });

  it("lists only rows with no category, and leaves out transfers when asked", async () => {
    const withTransfers = await getTransactions(householdId, { categoryId: null }, 50, null, db);
    expect(withTransfers.rows.map((r) => r.name).sort()).toEqual(["A transfer", "No category"]);

    const page = await getTransactions(householdId, { categoryId: null, excludeTransfers: true }, 50, null, db);
    expect(page.rows.map((r) => r.name)).toEqual(["No category"]);
  });
});
