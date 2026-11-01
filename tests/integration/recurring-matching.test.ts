import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";
import { insertHousehold, insertAccount, insertTransaction, insertRecurringTransaction } from "./helpers";
import { recurringTransactions, transactions } from "@/db/schema";
import { applyRecurringMatching } from "@/lib/recurring-matching";
import {
  makeTransactionRecurringScoped,
  linkTransactionToRecurringScoped,
  unlinkTransactionFromRecurringScoped,
  setRecurringStatusScoped,
  createRecurringTransactionScoped,
  updateRecurringRulesScoped,
} from "@/actions/recurring";
import type { LedgrDb } from "@/db";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let db: LedgrDb;
let close: () => Promise<void>;
let householdId: string;
let accountId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ({ householdId } = await insertHousehold(db));
  ({ accountId } = await insertAccount(db, householdId));
});
afterEach(async () => {
  await close();
});

const att = (over: Partial<typeof transactions.$inferInsert> = {}) => ({
  name: "AT&T Bill Payment",
  originalName: "AT&T Bill Payment",
  date: "2026-10-19",
  amount: 9220,
  normalizedAmount: -9220,
  ...over,
});

async function seedItem(over: Partial<typeof recurringTransactions.$inferInsert> = {}) {
  const { recurringId } = await insertRecurringTransaction(db, householdId, {
    name: "AT&T", accountId, frequency: "monthly", matchName: "at&t", ...over,
  });
  return recurringId;
}

const linkOf = async (id: string) =>
  (await db.select().from(transactions).where(eq(transactions.id, id)))[0].recurringTransactionId;

describe("applyRecurringMatching", () => {
  it("links a matching transaction and advances the item's dates", async () => {
    const recurringId = await seedItem({ lastDate: "2026-09-19", nextDate: "2026-10-19" });
    const { transactionId } = await insertTransaction(db, householdId, accountId, att());

    expect(await applyRecurringMatching(householdId, db)).toBe(1);

    expect(await linkOf(transactionId)).toBe(recurringId);
    const [item] = await db.select().from(recurringTransactions).where(eq(recurringTransactions.id, recurringId));
    expect(item).toMatchObject({ lastDate: "2026-10-19", lastAmount: -9220, nextDate: "2026-11-19" });
  });

  it("does not relink a transaction already linked to another item", async () => {
    const other = await seedItem({ name: "Other", matchName: "zzz" });
    await seedItem();
    const { transactionId } = await insertTransaction(db, householdId, accountId, att({ recurringTransactionId: other }));

    await applyRecurringMatching(householdId, db);

    expect(await linkOf(transactionId)).toBe(other);
  });

  it("does not relink a transaction the user unlinked", async () => {
    const recurringId = await seedItem();
    const { transactionId } = await insertTransaction(db, householdId, accountId, att());
    await applyRecurringMatching(householdId, db);
    expect(await unlinkTransactionFromRecurringScoped(householdId, transactionId, db)).toEqual({ success: true });

    await applyRecurringMatching(householdId, db);

    expect(await linkOf(transactionId)).toBeNull();
    expect(recurringId).toBeTruthy();
  });

  it("skips pending, transfer and income-sign transactions", async () => {
    await seedItem();
    const a = await insertTransaction(db, householdId, accountId, att({ pending: true }));
    const b = await insertTransaction(db, householdId, accountId, att({ isTransfer: true, date: "2026-10-20" }));
    const c = await insertTransaction(db, householdId, accountId, att({ normalizedAmount: 9220, date: "2026-10-21" }));

    expect(await applyRecurringMatching(householdId, db)).toBe(0);

    for (const t of [a, b, c]) expect(await linkOf(t.transactionId)).toBeNull();
  });

  it("an item with no match name matches nothing", async () => {
    await seedItem({ matchName: null });
    const { transactionId } = await insertTransaction(db, householdId, accountId, att());
    await applyRecurringMatching(householdId, db);
    expect(await linkOf(transactionId)).toBeNull();
  });

  it("ignores paused and archived items", async () => {
    await seedItem({ status: "paused" });
    await seedItem({ status: "archived" });
    const { transactionId } = await insertTransaction(db, householdId, accountId, att());
    await applyRecurringMatching(householdId, db);
    expect(await linkOf(transactionId)).toBeNull();
  });
});

describe("recurring actions", () => {
  it("makeTransactionRecurring creates an item from the transaction and links it", async () => {
    const { transactionId } = await insertTransaction(db, householdId, accountId, att());

    const result = await makeTransactionRecurringScoped(householdId, transactionId, db);

    expect("recurringId" in result).toBe(true);
    if (!("recurringId" in result)) return;
    const [item] = await db.select().from(recurringTransactions).where(eq(recurringTransactions.id, result.recurringId));
    expect(item).toMatchObject({
      name: "AT&T Bill Payment", matchName: "AT&T Bill Payment", averageAmount: 9220,
      frequency: "monthly", source: "manual", nextDate: "2026-11-19", accountId,
    });
    expect(await linkOf(transactionId)).toBe(result.recurringId);
  });

  it("rejects another household's transaction and item", async () => {
    const other = await insertHousehold(db, "Other");
    const { accountId: otherAcct } = await insertAccount(db, other.householdId);
    const { transactionId } = await insertTransaction(db, other.householdId, otherAcct, att());
    const recurringId = await seedItem();

    expect(await linkTransactionToRecurringScoped(householdId, recurringId, transactionId, db)).toHaveProperty("error");
    expect(await makeTransactionRecurringScoped(householdId, transactionId, db)).toHaveProperty("error");
    expect(await setRecurringStatusScoped(other.householdId, recurringId, "archived", db)).toHaveProperty("error");
  });

  it("createRecurringTransaction stores a manual item with the name as its match rule", async () => {
    const result = await createRecurringTransactionScoped(
      householdId,
      { name: "Gym", amount: 3999, frequency: "monthly", nextDate: "2026-11-05", categoryId: null, accountId: null },
      db,
    );
    expect("recurringId" in result).toBe(true);
    if (!("recurringId" in result)) return;
    const [item] = await db.select().from(recurringTransactions).where(eq(recurringTransactions.id, result.recurringId));
    expect(item).toMatchObject({ name: "Gym", matchName: "Gym", source: "manual", status: "active", averageAmount: 3999 });
  });

  it("resuming an item detection had marked stopped makes it live again", async () => {
    const recurringId = await seedItem({ isActive: false });
    await setRecurringStatusScoped(householdId, recurringId, "active", db);
    const [item] = await db.select().from(recurringTransactions).where(eq(recurringTransactions.id, recurringId));
    expect(item).toMatchObject({ status: "active", isActive: true });
  });

  it("renames an item and links by its match rule, independent of the display name", async () => {
    const recurringId = await seedItem({ name: "Phone Bill", matchName: null });
    const { transactionId } = await insertTransaction(db, householdId, accountId, att({ name: "Verizon Wireless Payment" }));

    const result = await updateRecurringRulesScoped(
      householdId,
      { id: recurringId, name: "Verizon", matchName: "verizon wireless", matchMinAmount: null, matchMaxAmount: null, matchDayOfMonth: null, frequency: "monthly" },
      db,
    );

    expect(result).toEqual({ success: true });
    const [item] = await db.select().from(recurringTransactions).where(eq(recurringTransactions.id, recurringId));
    expect(item).toMatchObject({ name: "Verizon", matchName: "verizon wireless" });
    expect(await linkOf(transactionId)).toBe(recurringId);
  });

  it("setRecurringStatus archives and restores", async () => {
    const recurringId = await seedItem();
    expect(await setRecurringStatusScoped(householdId, recurringId, "archived", db)).toEqual({ success: true });
    let [item] = await db.select().from(recurringTransactions).where(eq(recurringTransactions.id, recurringId));
    expect(item.status).toBe("archived");
    await setRecurringStatusScoped(householdId, recurringId, "active", db);
    [item] = await db.select().from(recurringTransactions).where(eq(recurringTransactions.id, recurringId));
    expect(item.status).toBe("active");
  });
});
