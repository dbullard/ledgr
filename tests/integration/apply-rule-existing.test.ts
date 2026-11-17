import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";
import {
  insertHousehold, insertAccount, insertTransaction, insertMerchant,
  insertCategoryGroup, insertCategory, insertTransactionSplit,
} from "./helpers";
import { previewRuleApplicationScoped, applyRuleToExistingScoped } from "../../src/actions/category-rules";
import { transactions } from "../../src/db/schema";
import type { LedgrDb } from "../../src/db";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../src/lib/demo-mode", () => ({ guardDemoMode: vi.fn(() => null) }));
vi.mock("../../src/lib/auth/session", () => ({
  getHouseholdId: vi.fn(),
  getSession: vi.fn(),
}));

describe("applying a category rule to existing transactions", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;
  let householdId: string;
  let accountId: string;
  let gas: string;
  let other: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    ({ householdId } = await insertHousehold(db));
    ({ accountId } = await insertAccount(db, householdId));
    const { groupId } = await insertCategoryGroup(db, householdId);
    ({ categoryId: gas } = await insertCategory(db, householdId, groupId, { name: "Gas" }));
    ({ categoryId: other } = await insertCategory(db, householdId, groupId, { name: "Other" }));
  });
  afterAll(async () => {
    await close();
  });

  const rule = (matchPattern: string, matchField: "name" | "merchant" = "name") => ({
    categoryId: gas, matchField, matchPattern,
  });
  const row = async (id: string) =>
    (await db.select().from(transactions).where(eq(transactions.id, id)))[0]!;
  const add = (name: string, o: Partial<typeof transactions.$inferInsert> = {}) =>
    insertTransaction(db, householdId, accountId, { name, originalName: name, ...o }).then((r) => r.transactionId);

  it("files uncategorized and guessed rows that match, as a rule, and leaves trusted ones alone", async () => {
    const uncategorized = await add("CASEYS #1");
    const lowercase = await add("caseys store 22");
    const aiGuess = await add("CASEYS #3", { categoryId: other, categorySource: "ai" });
    const historyGuess = await add("CASEYS #4", { categoryId: other, categorySource: "history" });
    const manual = await add("CASEYS #5", { categoryId: other, categorySource: "manual" });
    const ruled = await add("CASEYS #6", { categoryId: other, categorySource: "rule" });
    const pfc = await add("CASEYS #7", { categoryId: other, categorySource: "pfc" });
    const unrelated = await add("SHELL #8");

    expect(await previewRuleApplicationScoped(householdId, rule("caseys"), db)).toEqual({ count: 4 });
    expect(await applyRuleToExistingScoped(householdId, rule("caseys"), db)).toEqual({ updated: 4 });

    for (const id of [uncategorized, lowercase, aiGuess, historyGuess]) {
      expect(await row(id)).toMatchObject({ categoryId: gas, categorySource: "rule" });
    }
    for (const id of [manual, ruled, pfc]) expect((await row(id)).categoryId).toBe(other);
    expect((await row(manual)).categorySource).toBe("manual");
    expect((await row(unrelated)).categoryId).toBeNull();
  });

  it("promotes a guess that was already right, so it leaves the review queue", async () => {
    const id = await add("KUM AND GO #9", { categoryId: gas, categorySource: "history" });
    await applyRuleToExistingScoped(householdId, rule("kum and go"), db);
    expect(await row(id)).toMatchObject({ categoryId: gas, categorySource: "rule" });
  });

  it("skips transfers, deleted, hidden and split transactions", async () => {
    const transfer = await add("EXXON #1", { isTransfer: true });
    const deleted = await add("EXXON #2", { deletedAt: new Date() });
    const hidden = await add("EXXON #3", { isHidden: true });
    const split = await add("EXXON #4");
    await insertTransactionSplit(db, split, other, 500);
    const plain = await add("EXXON #5");

    expect(await applyRuleToExistingScoped(householdId, rule("exxon"), db)).toEqual({ updated: 1 });
    for (const id of [transfer, deleted, hidden, split]) expect((await row(id)).categoryId).toBeNull();
    expect((await row(plain)).categoryId).toBe(gas);
  });

  it("matches on the merchant name for a merchant rule", async () => {
    const { merchantId } = await insertMerchant(db, householdId, { name: "Valero" });
    const viaMerchant = await add("POS DEBIT 4411", { merchantId });
    const noMerchant = await add("POS DEBIT 4412");

    expect(await applyRuleToExistingScoped(householdId, rule("valero", "merchant"), db)).toEqual({ updated: 1 });
    expect((await row(viaMerchant)).categoryId).toBe(gas);
    expect((await row(noMerchant)).categoryId).toBeNull();
  });

  it("treats % and _ in the pattern literally", async () => {
    const literal = await add("SAVE 50% TODAY");
    const wouldMatchAsWildcard = await add("SAVE 500 TODAY");
    const underscore = await add("A_B STORE");
    const wildcardVictim = await add("AXB STORE");

    expect(await applyRuleToExistingScoped(householdId, rule("50% today"), db)).toEqual({ updated: 1 });
    expect(await applyRuleToExistingScoped(householdId, rule("a_b store"), db)).toEqual({ updated: 1 });
    expect((await row(literal)).categoryId).toBe(gas);
    expect((await row(underscore)).categoryId).toBe(gas);
    expect((await row(wouldMatchAsWildcard)).categoryId).toBeNull();
    expect((await row(wildcardVictim)).categoryId).toBeNull();
  });

  it("never touches another household's transactions", async () => {
    const { householdId: otherHh } = await insertHousehold(db);
    const { accountId: otherAcct } = await insertAccount(db, otherHh);
    const { transactionId } = await insertTransaction(db, otherHh, otherAcct, { name: "SPEEDWAY #1", originalName: "SPEEDWAY #1" });
    const mine = await add("SPEEDWAY #2");

    expect(await applyRuleToExistingScoped(householdId, rule("speedway"), db)).toEqual({ updated: 1 });
    expect((await row(transactionId)).categoryId).toBeNull();
    expect((await row(mine)).categoryId).toBe(gas);
  });

  it("rejects a blank pattern and a category from another household, and changes nothing", async () => {
    const victim = await add("ANYTHING #1");
    expect(await applyRuleToExistingScoped(householdId, rule("   "), db)).toHaveProperty("error");
    expect(await previewRuleApplicationScoped(householdId, rule(""), db)).toHaveProperty("error");

    const { householdId: otherHh } = await insertHousehold(db);
    const { groupId } = await insertCategoryGroup(db, otherHh);
    const { categoryId: theirs } = await insertCategory(db, otherHh, groupId, { name: "Theirs" });
    const res = await applyRuleToExistingScoped(householdId, { ...rule("anything"), categoryId: theirs }, db);
    expect(res).toEqual({ error: "Category not found" });
    expect((await row(victim)).categoryId).toBeNull();
  });

  it("reports zero when nothing matches", async () => {
    expect(await previewRuleApplicationScoped(householdId, rule("zzz-no-such-merchant"), db)).toEqual({ count: 0 });
    expect(await applyRuleToExistingScoped(householdId, rule("zzz-no-such-merchant"), db)).toEqual({ updated: 0 });
  });
});
