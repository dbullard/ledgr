"use server";

import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db as defaultDb, type LedgrDb } from "@/db";
import { recurringTransactions, recurringExclusions, transactions, categories } from "@/db/schema";
import { withHousehold } from "@/lib/household-context";
import { nextDateAfter } from "@/lib/recurring-match";
import { applyRecurringMatching } from "@/lib/recurring-matching";
import { scopedQuery } from "@/lib/scoped-query";
import { authorizeAction } from "@/lib/auth/authorize-action";

type ActionResult = { success: true } | { error: string };

const FREQUENCIES = ["weekly", "biweekly", "semimonthly", "monthly", "yearly"] as const;

const updateSchema = z.object({
  id: z.string().min(1),
  name: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(200)),
  // Null clears the category. A bill with no category is a normal state --
  // every detected bill starts that way.
  categoryId: z.string().min(1).nullable(),
  // Amounts are displayed via Math.abs, so a negative would render identically
  // while corrupting the sign handling behind the monthly total.
  averageAmount: z.number().int().min(0),
  frequency: z.enum(FREQUENCIES),
  isActive: z.boolean(),
});

export type RecurringUpdateInput = z.input<typeof updateSchema>;

/**
 * A bill points at a category, so the category must belong to the same
 * household -- otherwise a caller could aim a bill at another household's
 * category id and read its name back off the bills list.
 */
async function categoryBelongsToHousehold(
  householdId: string,
  categoryId: string,
  db: LedgrDb,
): Promise<boolean> {
  const scoped = scopedQuery(householdId, db);
  const [row] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(scoped.where(categories, eq(categories.id, categoryId)))
    .limit(1);
  return !!row;
}

export async function updateRecurringTransactionScoped(
  householdId: string,
  input: RecurringUpdateInput,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { error: "Check the name, amount and frequency." };

  if (
    parsed.data.categoryId !== null &&
    !(await categoryBelongsToHousehold(householdId, parsed.data.categoryId, db))
  ) {
    return { error: "Category not found" };
  }

  const scoped = scopedQuery(householdId, db);
  const updated = await db
    .update(recurringTransactions)
    .set({
      name: parsed.data.name,
      categoryId: parsed.data.categoryId,
      averageAmount: parsed.data.averageAmount,
      frequency: parsed.data.frequency,
      // Muting keeps the row: getUpcomingBills and getRecurringSummary both
      // filter on isActive, so the bill leaves the list and the monthly total
      // while the record survives -- otherwise the next sync would re-detect
      // it as new and the user would have to mute it again.
      isActive: parsed.data.isActive,
      updatedAt: new Date(),
    })
    .where(scoped.where(recurringTransactions, eq(recurringTransactions.id, parsed.data.id)))
    .returning({ id: recurringTransactions.id });

  if (updated.length === 0) return { error: "Bill not found" };

  revalidatePath("/recurrings");
  revalidatePath("/");
  return { success: true };
}

export async function updateRecurringTransaction(
  input: RecurringUpdateInput,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return updateRecurringTransactionScoped(auth.householdId, input, db);
}

export async function deleteRecurringTransactionScoped(
  householdId: string,
  billId: string,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsed = z.string().min(1).safeParse(billId);
  if (!parsed.success) return { error: "Invalid input" };

  const scoped = scopedQuery(householdId, db);
  const deleted = await db
    .delete(recurringTransactions)
    .where(scoped.where(recurringTransactions, eq(recurringTransactions.id, parsed.data)))
    .returning({ id: recurringTransactions.id });

  if (deleted.length === 0) return { error: "Bill not found" };

  revalidatePath("/recurrings");
  revalidatePath("/");
  return { success: true };
}

export async function deleteRecurringTransaction(
  billId: string,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return deleteRecurringTransactionScoped(auth.householdId, billId, db);
}

// ---------------------------------------------------------------------------
// Status, creation, match rules and transaction links

const idSchema = z.string().min(1);

function refresh() {
  revalidatePath("/recurrings");
  revalidatePath("/");
}

export async function setRecurringStatusScoped(
  householdId: string,
  id: string,
  status: "active" | "paused" | "archived",
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsed = z.object({ id: idSchema, status: z.enum(["active", "paused", "archived"]) }).safeParse({ id, status });
  if (!parsed.success) return { error: "Invalid input" };

  const scoped = scopedQuery(householdId, db);
  const updated = await db
    .update(recurringTransactions)
    .set({ status: parsed.data.status, updatedAt: new Date() })
    .where(scoped.where(recurringTransactions, eq(recurringTransactions.id, parsed.data.id)))
    .returning({ id: recurringTransactions.id });
  if (updated.length === 0) return { error: "Recurring item not found" };
  refresh();
  return { success: true };
}

export async function setRecurringStatus(id: string, status: "active" | "paused" | "archived", db: LedgrDb = defaultDb) {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return setRecurringStatusScoped(auth.householdId, id, status, db);
}

const createSchema = z.object({
  name: z.string().transform((s) => s.trim()).pipe(z.string().min(1).max(200)),
  amount: z.number().int().min(0),
  frequency: z.enum(FREQUENCIES),
  nextDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  categoryId: z.string().min(1).nullable(),
  accountId: z.string().min(1).nullable(),
});
export type RecurringCreateInput = z.input<typeof createSchema>;

export async function createRecurringTransactionScoped(
  householdId: string,
  input: RecurringCreateInput,
  db: LedgrDb = defaultDb,
): Promise<{ success: true; recurringId: string } | { error: string }> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: "Check the name, amount, frequency and date." };
  const d = parsed.data;
  if (d.categoryId !== null && !(await categoryBelongsToHousehold(householdId, d.categoryId, db))) {
    return { error: "Category not found" };
  }

  const recurringId = uuid();
  const now = new Date();
  await db.insert(recurringTransactions).values({
    id: recurringId,
    householdId,
    name: d.name,
    accountId: d.accountId,
    categoryId: d.categoryId,
    averageAmount: d.amount,
    lastAmount: -d.amount,
    frequency: d.frequency,
    nextDate: d.nextDate,
    isActive: true,
    isIncome: false,
    status: "active",
    source: "manual",
    matchName: d.name,
    createdAt: now,
    updatedAt: now,
  });
  await applyRecurringMatching(householdId, db);
  refresh();
  return { success: true, recurringId };
}

export async function createRecurringTransaction(input: RecurringCreateInput, db: LedgrDb = defaultDb) {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return createRecurringTransactionScoped(auth.householdId, input, db);
}

/** Turns one transaction into a recurring item and links it. */
export async function makeTransactionRecurringScoped(
  householdId: string,
  transactionId: string,
  db: LedgrDb = defaultDb,
): Promise<{ success: true; recurringId: string } | { error: string }> {
  const parsed = idSchema.safeParse(transactionId);
  if (!parsed.success) return { error: "Invalid input" };

  return withHousehold(householdId, async (tx) => {
    const scopedTx = scopedQuery(householdId, tx);
    const [txn] = await tx
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        name: transactions.name,
        date: transactions.date,
        normalizedAmount: transactions.normalizedAmount,
        categoryId: transactions.categoryId,
      })
      .from(transactions)
      .where(scopedTx.where(transactions, eq(transactions.id, parsed.data)))
      .limit(1);
    if (!txn) return { error: "Transaction not found" };

    const recurringId = uuid();
    const now = new Date();
    await tx.insert(recurringTransactions).values({
      id: recurringId,
      householdId,
      name: txn.name,
      accountId: txn.accountId,
      categoryId: txn.categoryId,
      averageAmount: Math.abs(txn.normalizedAmount),
      lastAmount: txn.normalizedAmount,
      frequency: "monthly",
      lastDate: txn.date,
      nextDate: nextDateAfter(txn.date, "monthly"),
      isActive: true,
      isIncome: txn.normalizedAmount > 0,
      status: "active",
      source: "manual",
      matchName: txn.name,
      createdAt: now,
      updatedAt: now,
    });
    await tx
      .update(transactions)
      .set({ recurringTransactionId: recurringId, updatedAt: now })
      .where(eq(transactions.id, txn.id));
    refresh();
    return { success: true as const, recurringId };
  }, db);
}

export async function makeTransactionRecurring(transactionId: string, db: LedgrDb = defaultDb) {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return makeTransactionRecurringScoped(auth.householdId, transactionId, db);
}

const rulesSchema = z.object({
  id: idSchema,
  matchName: z.string().transform((s) => s.trim()).pipe(z.string().min(1).max(200)),
  matchMinAmount: z.number().int().min(0).nullable(),
  matchMaxAmount: z.number().int().min(0).nullable(),
  matchDayOfMonth: z.number().int().min(1).max(31).nullable(),
  frequency: z.enum(FREQUENCIES),
});
export type RecurringRulesInput = z.input<typeof rulesSchema>;

export async function updateRecurringRulesScoped(
  householdId: string,
  input: RecurringRulesInput,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsed = rulesSchema.safeParse(input);
  if (!parsed.success) return { error: "Check the match rules." };
  const d = parsed.data;
  if (d.matchMinAmount !== null && d.matchMaxAmount !== null && d.matchMinAmount > d.matchMaxAmount) {
    return { error: "Minimum amount can't be above the maximum." };
  }

  const scoped = scopedQuery(householdId, db);
  const updated = await db
    .update(recurringTransactions)
    .set({
      matchName: d.matchName,
      matchMinAmount: d.matchMinAmount,
      matchMaxAmount: d.matchMaxAmount,
      matchDayOfMonth: d.matchDayOfMonth,
      frequency: d.frequency,
      updatedAt: new Date(),
    })
    .where(scoped.where(recurringTransactions, eq(recurringTransactions.id, d.id)))
    .returning({ id: recurringTransactions.id });
  if (updated.length === 0) return { error: "Recurring item not found" };

  await applyRecurringMatching(householdId, db);
  refresh();
  return { success: true };
}

export async function updateRecurringRules(input: RecurringRulesInput, db: LedgrDb = defaultDb) {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return updateRecurringRulesScoped(auth.householdId, input, db);
}

export async function linkTransactionToRecurringScoped(
  householdId: string,
  recurringId: string,
  transactionId: string,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsed = z.object({ r: idSchema, t: idSchema }).safeParse({ r: recurringId, t: transactionId });
  if (!parsed.success) return { error: "Invalid input" };

  return withHousehold(householdId, async (tx) => {
    const scopedTx = scopedQuery(householdId, tx);
    const [item] = await tx
      .select({ id: recurringTransactions.id })
      .from(recurringTransactions)
      .where(scopedTx.where(recurringTransactions, eq(recurringTransactions.id, parsed.data.r)))
      .limit(1);
    const [txn] = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(scopedTx.where(transactions, eq(transactions.id, parsed.data.t)))
      .limit(1);
    if (!item || !txn) return { error: "Not found" };

    await tx
      .delete(recurringExclusions)
      .where(and(eq(recurringExclusions.recurringId, item.id), eq(recurringExclusions.transactionId, txn.id)));
    await tx
      .update(transactions)
      .set({ recurringTransactionId: item.id, updatedAt: new Date() })
      .where(eq(transactions.id, txn.id));
    refresh();
    return { success: true as const };
  }, db);
}

export async function linkTransactionToRecurring(recurringId: string, transactionId: string, db: LedgrDb = defaultDb) {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return linkTransactionToRecurringScoped(auth.householdId, recurringId, transactionId, db);
}

export async function unlinkTransactionFromRecurringScoped(
  householdId: string,
  transactionId: string,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsed = idSchema.safeParse(transactionId);
  if (!parsed.success) return { error: "Invalid input" };

  return withHousehold(householdId, async (tx) => {
    const scopedTx = scopedQuery(householdId, tx);
    const [txn] = await tx
      .select({ id: transactions.id, recurringId: transactions.recurringTransactionId })
      .from(transactions)
      .where(scopedTx.where(transactions, eq(transactions.id, parsed.data)))
      .limit(1);
    if (!txn) return { error: "Transaction not found" };

    if (txn.recurringId) {
      await tx
        .insert(recurringExclusions)
        .values({ recurringId: txn.recurringId, transactionId: txn.id })
        .onConflictDoNothing();
    }
    await tx
      .update(transactions)
      .set({ recurringTransactionId: null, updatedAt: new Date() })
      .where(eq(transactions.id, txn.id));
    refresh();
    return { success: true as const };
  }, db);
}

export async function unlinkTransactionFromRecurring(transactionId: string, db: LedgrDb = defaultDb) {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return unlinkTransactionFromRecurringScoped(auth.householdId, transactionId, db);
}
