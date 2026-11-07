import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";
import {
  insertAccount,
  insertCategory,
  insertBudget,
  insertBudgetCategory,
  insertCategoryGroup,
  insertCategoryRule,
  insertHousehold,
  insertMerchant,
  insertRecurringTransaction,
  insertTransaction,
  insertTransactionSplit,
} from "./helpers";
import {
  createCategoryGroupScoped,
  createCategoryScoped,
  deleteCategoryGroupScoped,
  deleteCategoryScoped,
  renameCategoryGroupScoped,
  renameCategoryScoped,
  mergeCategoriesScoped,
  mergeCategoryGroupsScoped,
  moveCategoryToGroupScoped,
  updateCategoryGroupIconScoped,
  updateCategoryIconScoped,
  updateCategoryColorScoped,
  updateCategoryReportingScoped,
  updateCategoryExclusionScoped,
} from "../../src/actions/categories";
import {
  budgetCategories,
  categories,
  categoryGroups,
  categoryRules,
  merchants,
  recurringTransactions,
  transactionSplits,
  transactions,
} from "../../src/db/schema";
import type { LedgrDb } from "../../src/db";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

describe("category actions", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;
  let householdId: string;
  let otherHouseholdId: string;
  let accountId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    ({ householdId } = await insertHousehold(db, "Primary"));
    ({ householdId: otherHouseholdId } = await insertHousehold(db, "Other"));
    ({ accountId } = await insertAccount(db, householdId));
  });

  afterAll(async () => {
    await close();
  });

  it("creates custom groups and categories in the requested household", async () => {
    const groupResult = await createCategoryGroupScoped(householdId, "  Family  ", db);
    expect(groupResult).toHaveProperty("id");
    if (!("id" in groupResult)) throw new Error(groupResult.error);

    const categoryResult = await createCategoryScoped(
      householdId,
      { groupId: groupResult.id, name: "Childcare", isIncome: false },
      db,
    );
    expect(categoryResult).toHaveProperty("id");
    if (!("id" in categoryResult)) throw new Error(categoryResult.error);

    const [group] = await db
      .select()
      .from(categoryGroups)
      .where(eq(categoryGroups.id, groupResult.id));
    const [category] = await db
      .select()
      .from(categories)
      .where(eq(categories.id, categoryResult.id));

    expect(group).toMatchObject({ householdId, name: "Family", isSystem: false });
    expect(category).toMatchObject({
      householdId,
      groupId: groupResult.id,
      name: "Childcare",
      isSystem: false,
      includeTransferInSpending: false,
    });
  });

  it("will not create a category in another household's group", async () => {
    const { groupId } = await insertCategoryGroup(db, otherHouseholdId);

    const result = await createCategoryScoped(
      householdId,
      { groupId, name: "Not Mine", isIncome: false },
      db,
    );

    expect(result).toEqual({ error: "Category group not found." });
  });

  it("renames system and custom records but protects other-household records", async () => {
    const { groupId } = await insertCategoryGroup(db, householdId, { name: "Old Group" });
    const { categoryId } = await insertCategory(db, householdId, groupId, { name: "Old Category" });
    const { groupId: systemGroupId } = await insertCategoryGroup(db, householdId, {
      name: "System Group",
      isSystem: true,
    });
    const { categoryId: systemCategoryId } = await insertCategory(
      db,
      householdId,
      systemGroupId,
      { name: "System Category", isSystem: true },
    );
    const { groupId: otherGroupId } = await insertCategoryGroup(db, otherHouseholdId);

    expect(await renameCategoryGroupScoped(householdId, groupId, "New Group", db)).toEqual({
      success: true,
    });
    expect(await renameCategoryScoped(householdId, categoryId, "New Category", db)).toEqual({
      success: true,
    });
    expect(await renameCategoryGroupScoped(householdId, systemGroupId, "Changed", db)).toEqual({
      success: true,
    });
    expect(await renameCategoryScoped(householdId, systemCategoryId, "Changed", db)).toEqual({
      success: true,
    });
    expect(await renameCategoryGroupScoped(householdId, otherGroupId, "Changed", db)).toHaveProperty(
      "error",
    );
  });

  it("updates the transfer-as-spending flag only for custom categories in the household", async () => {
    const { groupId } = await insertCategoryGroup(db, householdId);
    const { categoryId } = await insertCategory(db, householdId, groupId);
    const { categoryId: systemCategoryId } = await insertCategory(db, householdId, groupId, {
      isSystem: true,
    });
    const { groupId: otherGroupId } = await insertCategoryGroup(db, otherHouseholdId);
    const { categoryId: otherCategoryId } = await insertCategory(
      db,
      otherHouseholdId,
      otherGroupId,
    );

    expect(await updateCategoryReportingScoped(householdId, categoryId, true, db)).toEqual({
      success: true,
    });
    expect(await updateCategoryReportingScoped(householdId, systemCategoryId, true, db)).toHaveProperty(
      "error",
    );
    expect(await updateCategoryReportingScoped(householdId, otherCategoryId, true, db)).toHaveProperty(
      "error",
    );

    const rows = await db
      .select({ id: categories.id, flag: categories.includeTransferInSpending })
      .from(categories);
    const flags = new Map(rows.map((row) => [row.id, row.flag]));
    expect(flags.get(categoryId)).toBe(true);
    expect(flags.get(systemCategoryId)).toBe(false);
    expect(flags.get(otherCategoryId)).toBe(false);

    expect(await updateCategoryReportingScoped(householdId, categoryId, false, db)).toEqual({
      success: true,
    });
    const [cleared] = await db
      .select({ flag: categories.includeTransferInSpending })
      .from(categories)
      .where(eq(categories.id, categoryId));
    expect(cleared.flag).toBe(false);
  });

  it("updates the exclude-from-spending flag only for custom, non-income categories in the household", async () => {
    const { groupId } = await insertCategoryGroup(db, householdId);
    const { categoryId } = await insertCategory(db, householdId, groupId);
    const { categoryId: systemCategoryId } = await insertCategory(db, householdId, groupId, {
      isSystem: true,
    });
    const { categoryId: incomeCategoryId } = await insertCategory(db, householdId, groupId, {
      isIncome: true,
    });
    const { groupId: otherGroupId } = await insertCategoryGroup(db, otherHouseholdId);
    const { categoryId: otherCategoryId } = await insertCategory(db, otherHouseholdId, otherGroupId);

    expect(await updateCategoryExclusionScoped(householdId, categoryId, true, db)).toEqual({
      success: true,
    });
    for (const id of [systemCategoryId, incomeCategoryId, otherCategoryId]) {
      expect(await updateCategoryExclusionScoped(householdId, id, true, db)).toHaveProperty("error");
    }

    const rows = await db
      .select({ id: categories.id, flag: categories.excludeFromSpending })
      .from(categories);
    const flags = new Map(rows.map((row) => [row.id, row.flag]));
    expect(flags.get(categoryId)).toBe(true);
    expect(flags.get(systemCategoryId)).toBe(false);
    expect(flags.get(incomeCategoryId)).toBe(false);
    expect(flags.get(otherCategoryId)).toBe(false);

    expect(await updateCategoryExclusionScoped(householdId, categoryId, false, db)).toEqual({
      success: true,
    });
  });

  it("never stores the flag on an income category", async () => {
    const { groupId } = await insertCategoryGroup(db, householdId);
    const result = await createCategoryScoped(householdId, {
      groupId,
      name: "Side income",
      isIncome: true,
      includeTransferInSpending: true,
    }, db);
    expect(result).toHaveProperty("success", true);
    const [row] = await db
      .select({ flag: categories.includeTransferInSpending })
      .from(categories)
      .where(eq(categories.id, (result as { id: string }).id));
    expect(row.flag).toBe(false);
  });

  it("deletes an unused custom category but refuses one referenced by a transaction", async () => {
    const { groupId } = await insertCategoryGroup(db, householdId);
    const { categoryId: unusedId } = await insertCategory(db, householdId, groupId, {
      name: "Unused",
    });
    const { categoryId: usedId } = await insertCategory(db, householdId, groupId, {
      name: "Used",
    });
    await insertTransaction(db, householdId, accountId, { categoryId: usedId });

    expect(await deleteCategoryScoped(householdId, usedId, db)).toEqual({
      error: "This category is in use and cannot be deleted.",
    });
    expect(await deleteCategoryScoped(householdId, unusedId, db)).toEqual({ success: true });

    const deleted = await db.select().from(categories).where(eq(categories.id, unusedId));
    expect(deleted).toHaveLength(0);
  });

  it("deletes only empty custom groups", async () => {
    const { groupId } = await insertCategoryGroup(db, householdId, { name: "Custom Group" });
    const { categoryId } = await insertCategory(db, householdId, groupId);
    const { groupId: systemGroupId } = await insertCategoryGroup(db, householdId, {
      isSystem: true,
    });

    expect(await deleteCategoryGroupScoped(householdId, groupId, db)).toEqual({
      error: "Delete or move the categories in this group first.",
    });
    expect(await deleteCategoryGroupScoped(householdId, systemGroupId, db)).toEqual({
      error: "System category groups cannot be deleted.",
    });

    expect(await deleteCategoryScoped(householdId, categoryId, db)).toEqual({ success: true });
    expect(await deleteCategoryGroupScoped(householdId, groupId, db)).toEqual({ success: true });
  });

  describe("duplicate names", () => {
    it("rejects a custom category that duplicates a system name, ignoring case and whitespace", async () => {
      const { groupId } = await insertCategoryGroup(db, householdId, { isSystem: true });
      await insertCategory(db, householdId, groupId, { name: "Groceries", isSystem: true });

      const result = await createCategoryScoped(
        householdId,
        { groupId, name: "  gROCERIES ", isIncome: false },
        db,
      );
      expect(result).toEqual({ error: "A category with that name already exists." });
    });

    it("rejects renaming to another category's name but allows a case change of its own", async () => {
      const { groupId } = await insertCategoryGroup(db, householdId);
      await insertCategory(db, householdId, groupId, { name: "Pets" });
      const { categoryId } = await insertCategory(db, householdId, groupId, { name: "Hobbies" });

      expect(await renameCategoryScoped(householdId, categoryId, "pets", db)).toEqual({
        error: "A category with that name already exists.",
      });
      expect(await renameCategoryScoped(householdId, categoryId, "HOBBIES", db)).toEqual({
        success: true,
      });
    });

    it("does not treat another household's category name as a duplicate", async () => {
      const { groupId: otherGroupId } = await insertCategoryGroup(db, otherHouseholdId);
      await insertCategory(db, otherHouseholdId, otherGroupId, { name: "Shared Name" });
      const { groupId } = await insertCategoryGroup(db, householdId);

      const result = await createCategoryScoped(
        householdId,
        { groupId, name: "Shared Name", isIncome: false },
        db,
      );
      expect(result).toHaveProperty("id");
    });
  });
  it("sets icons on system and custom categories and groups, and rejects bad names", async () => {
    const { groupId } = await insertCategoryGroup(db, householdId, { isSystem: true });
    const { categoryId } = await insertCategory(db, householdId, groupId, { isSystem: true });

    expect(await updateCategoryIconScoped(householdId, categoryId, "baby", db)).toEqual({
      success: true,
    });
    expect(await updateCategoryGroupIconScoped(householdId, groupId, "home", db)).toEqual({
      success: true,
    });
    const [cat] = await db.select().from(categories).where(eq(categories.id, categoryId));
    expect(cat.icon).toBe("baby");
    expect(await updateCategoryIconScoped(householdId, categoryId, null, db)).toEqual({
      success: true,
    });
    expect(await updateCategoryIconScoped(householdId, categoryId, "Bad Name!", db)).toHaveProperty(
      "error",
    );
    expect(
      await updateCategoryIconScoped(otherHouseholdId, categoryId, "baby", db),
    ).toHaveProperty("error");
  });

  it("sets and clears a category colour, rejecting malformed values and other households", async () => {
    const { groupId } = await insertCategoryGroup(db, householdId);
    const { categoryId } = await insertCategory(db, householdId, groupId);

    expect(await updateCategoryColorScoped(householdId, categoryId, "#FF9F0A", db)).toEqual({ success: true });
    let [cat] = await db.select().from(categories).where(eq(categories.id, categoryId));
    expect(cat.color).toBe("#FF9F0A");

    expect(await updateCategoryColorScoped(householdId, categoryId, "orange", db)).toHaveProperty("error");
    expect(await updateCategoryColorScoped(otherHouseholdId, categoryId, "#000000", db)).toHaveProperty("error");

    expect(await updateCategoryColorScoped(householdId, categoryId, null, db)).toEqual({ success: true });
    [cat] = await db.select().from(categories).where(eq(categories.id, categoryId));
    expect(cat.color).toBeNull();
  });

  it("moves a category to another group", async () => {
    const { groupId: from } = await insertCategoryGroup(db, householdId);
    const { groupId: to } = await insertCategoryGroup(db, householdId);
    const { categoryId } = await insertCategory(db, householdId, from);

    expect(await moveCategoryToGroupScoped(householdId, categoryId, to, db)).toEqual({
      success: true,
    });
    const [cat] = await db.select().from(categories).where(eq(categories.id, categoryId));
    expect(cat.groupId).toBe(to);
    expect(await moveCategoryToGroupScoped(householdId, categoryId, "missing", db)).toHaveProperty(
      "error",
    );
  });

  describe("merging", () => {
    it("repoints every reference, sums budget lines, and carries the PFC key", async () => {
      const { groupId } = await insertCategoryGroup(db, householdId);
      const { categoryId: source } = await insertCategory(db, householdId, groupId, {
        name: "Merge Source",
        isSystem: true,
        systemKey: "Restaurants",
      });
      const { categoryId: target } = await insertCategory(db, householdId, groupId, {
        name: "Merge Target",
        isSystem: true,
        systemKey: "Dining",
      });
      const { transactionId } = await insertTransaction(db, householdId, accountId, {
        categoryId: source,
      });
      const { transactionId: splitTxn } = await insertTransaction(db, householdId, accountId);
      const { splitId } = await insertTransactionSplit(db, splitTxn, source, 500);
      const { ruleId } = (await insertCategoryRule(db, householdId, source)) as { ruleId: string };
      const { merchantId } = await insertMerchant(db, householdId, { categoryId: source });
      const { recurringId } = await insertRecurringTransaction(db, householdId, {
        categoryId: source,
      });
      const { budgetId } = await insertBudget(db, householdId, { month: "2026-06" });
      await insertBudgetCategory(db, budgetId, source, { limitAmount: 4000 });
      await insertBudgetCategory(db, budgetId, target, { limitAmount: 6000 });
      const { budgetId: soloBudget } = await insertBudget(db, householdId, { month: "2026-07" });
      await insertBudgetCategory(db, soloBudget, source, { limitAmount: 2500 });

      const result = await mergeCategoriesScoped(householdId, source, target, db);
      expect(result).toEqual({ success: true, moved: 1 });

      const [txn] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
      expect(txn.categoryId).toBe(target);
      const [split] = await db
        .select()
        .from(transactionSplits)
        .where(eq(transactionSplits.id, splitId));
      expect(split.categoryId).toBe(target);
      const [rule] = await db.select().from(categoryRules).where(eq(categoryRules.id, ruleId));
      expect(rule.categoryId).toBe(target);
      const [merchant] = await db.select().from(merchants).where(eq(merchants.id, merchantId));
      expect(merchant.categoryId).toBe(target);
      const [recurring] = await db
        .select()
        .from(recurringTransactions)
        .where(eq(recurringTransactions.id, recurringId));
      expect(recurring.categoryId).toBe(target);

      const lines = await db.select().from(budgetCategories);
      const june = lines.filter((l) => l.budgetId === budgetId);
      expect(june).toHaveLength(1);
      expect(june[0]).toMatchObject({ categoryId: target, limitAmount: 10000 });
      const july = lines.filter((l) => l.budgetId === soloBudget);
      expect(july[0]).toMatchObject({ categoryId: target, limitAmount: 2500 });

      const remaining = await db.select().from(categories).where(eq(categories.id, source));
      expect(remaining).toHaveLength(0);
      const [merged] = await db.select().from(categories).where(eq(categories.id, target));
      expect(merged.systemKey).toBe("Dining|Restaurants");
    });

    it("refuses same, cross-household, and income/expense merges", async () => {
      const { groupId } = await insertCategoryGroup(db, householdId);
      const { categoryId: expense } = await insertCategory(db, householdId, groupId, {
        isIncome: false,
      });
      const { categoryId: income } = await insertCategory(db, householdId, groupId, {
        isIncome: true,
      });
      const { groupId: otherGroup } = await insertCategoryGroup(db, otherHouseholdId);
      const { categoryId: foreign } = await insertCategory(db, otherHouseholdId, otherGroup);

      expect(await mergeCategoriesScoped(householdId, expense, expense, db)).toHaveProperty("error");
      expect(await mergeCategoriesScoped(householdId, expense, income, db)).toHaveProperty("error");
      expect(await mergeCategoriesScoped(householdId, expense, foreign, db)).toHaveProperty("error");
      expect(await mergeCategoriesScoped(householdId, foreign, expense, db)).toHaveProperty("error");
    });

    it("merges a group by moving its categories and deleting it", async () => {
      const { groupId: source } = await insertCategoryGroup(db, householdId, { name: "Healthcare X" });
      const { groupId: target } = await insertCategoryGroup(db, householdId, { name: "Health X" });
      const { categoryId: kept } = await insertCategory(db, householdId, target, { sortOrder: 0 });
      const { categoryId: moved } = await insertCategory(db, householdId, source, { sortOrder: 0 });

      const result = await mergeCategoryGroupsScoped(householdId, source, target, db);
      expect(result).toEqual({ success: true, moved: 1 });
      const [movedRow] = await db.select().from(categories).where(eq(categories.id, moved));
      const [keptRow] = await db.select().from(categories).where(eq(categories.id, kept));
      expect(movedRow.groupId).toBe(target);
      expect(movedRow.sortOrder).toBeGreaterThan(keptRow.sortOrder ?? 0);
      expect(await db.select().from(categoryGroups).where(eq(categoryGroups.id, source))).toHaveLength(0);
      expect(await mergeCategoryGroupsScoped(householdId, target, target, db)).toHaveProperty("error");
    });
  });
});
