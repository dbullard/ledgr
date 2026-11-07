"use server";

import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { db as defaultDb, type LedgrDb } from "@/db";
import {
  budgetCategories,
  budgets,
  categories,
  categoryGroups,
  categoryRules,
  merchants,
  recurringTransactions,
  transactionSplits,
  transactions,
} from "@/db/schema";
import { authorizeAction } from "@/lib/auth/authorize-action";
import { scopedQuery } from "@/lib/scoped-query";

type ActionResult = { success: true } | { error: string };
type CreateResult = { success: true; id: string } | { error: string };

const idSchema = z.string().min(1);
const nameSchema = z.string().trim().min(1).max(80);
const categoryInputSchema = z.object({
  groupId: idSchema,
  name: nameSchema,
  isIncome: z.boolean().default(false),
  includeTransferInSpending: z.boolean().default(false),
  excludeFromSpending: z.boolean().default(false),
});

function revalidateCategoryConsumers() {
  for (const path of ["/categories", "/transactions", "/rules", "/budgets", "/recurrings", "/reports"]) {
    revalidatePath(path);
  }
}

async function getOwnedGroup(householdId: string, groupId: string, db: LedgrDb) {
  const scoped = scopedQuery(householdId, db);
  const [group] = await db
    .select({ id: categoryGroups.id, isSystem: categoryGroups.isSystem })
    .from(categoryGroups)
    .where(scoped.where(categoryGroups, eq(categoryGroups.id, groupId)))
    .limit(1);
  return group;
}

async function getOwnedCategory(householdId: string, categoryId: string, db: LedgrDb) {
  const scoped = scopedQuery(householdId, db);
  const [category] = await db
    .select({ id: categories.id, isSystem: categories.isSystem })
    .from(categories)
    .where(scoped.where(categories, eq(categories.id, categoryId)))
    .limit(1);
  return category;
}

function normalizeName(name: string) {
  return name.trim().toLowerCase();
}

/**
 * Category names must be unique per household, system or custom. The
 * categorization engine maps Plaid PFC categories to IDs by name, so a custom
 * category shadowing a system name would capture that categorization.
 */
async function categoryNameTaken(
  householdId: string,
  name: string,
  db: LedgrDb,
  excludeId?: string,
): Promise<boolean> {
  const scoped = scopedQuery(householdId, db);
  const rows = await db
    .select({ name: categories.name })
    .from(categories)
    .where(
      excludeId
        ? scoped.where(categories, ne(categories.id, excludeId))
        : scoped.where(categories),
    );
  const wanted = normalizeName(name);
  return rows.some((row) => normalizeName(row.name) === wanted);
}

async function groupNameTaken(
  householdId: string,
  name: string,
  db: LedgrDb,
  excludeId?: string,
): Promise<boolean> {
  const scoped = scopedQuery(householdId, db);
  const rows = await db
    .select({ name: categoryGroups.name })
    .from(categoryGroups)
    .where(
      excludeId
        ? scoped.where(categoryGroups, ne(categoryGroups.id, excludeId))
        : scoped.where(categoryGroups),
    );
  const wanted = normalizeName(name);
  return rows.some((row) => normalizeName(row.name) === wanted);
}

export async function createCategoryGroupScoped(
  householdId: string,
  name: string,
  db: LedgrDb = defaultDb,
): Promise<CreateResult> {
  const parsed = nameSchema.safeParse(name);
  if (!parsed.success) return { error: "Enter a group name between 1 and 80 characters." };
  if (await groupNameTaken(householdId, parsed.data, db)) {
    return { error: "A category group with that name already exists." };
  }

  const scoped = scopedQuery(householdId, db);
  const [last] = await db
    .select({ sortOrder: categoryGroups.sortOrder })
    .from(categoryGroups)
    .where(scoped.where(categoryGroups))
    .orderBy(desc(categoryGroups.sortOrder))
    .limit(1);

  const id = uuid();
  await db.insert(categoryGroups).values({
    id,
    householdId,
    name: parsed.data,
    isSystem: false,
    sortOrder: (last?.sortOrder ?? -1) + 1,
  });

  revalidateCategoryConsumers();
  return { success: true, id };
}

export async function createCategoryGroup(
  name: string,
  db: LedgrDb = defaultDb,
): Promise<CreateResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return createCategoryGroupScoped(auth.householdId, name, db);
}

export async function createCategoryScoped(
  householdId: string,
  input: z.input<typeof categoryInputSchema>,
  db: LedgrDb = defaultDb,
): Promise<CreateResult> {
  const parsed = categoryInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Enter a valid category name and group." };

  const group = await getOwnedGroup(householdId, parsed.data.groupId, db);
  if (!group) return { error: "Category group not found." };
  if (await categoryNameTaken(householdId, parsed.data.name, db)) {
    return { error: "A category with that name already exists." };
  }

  const scoped = scopedQuery(householdId, db);
  const [last] = await db
    .select({ sortOrder: categories.sortOrder })
    .from(categories)
    .where(scoped.where(categories, eq(categories.groupId, parsed.data.groupId)))
    .orderBy(desc(categories.sortOrder))
    .limit(1);

  const id = uuid();
  await db.insert(categories).values({
    id,
    householdId,
    groupId: parsed.data.groupId,
    name: parsed.data.name,
    isIncome: parsed.data.isIncome,
    // An income category has no spending side for a transfer to join.
    includeTransferInSpending: parsed.data.isIncome ? false : parsed.data.includeTransferInSpending,
    excludeFromSpending: parsed.data.isIncome ? false : parsed.data.excludeFromSpending,
    isSystem: false,
    sortOrder: (last?.sortOrder ?? -1) + 1,
  });

  revalidateCategoryConsumers();
  return { success: true, id };
}

export async function createCategory(
  input: z.input<typeof categoryInputSchema>,
  db: LedgrDb = defaultDb,
): Promise<CreateResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return createCategoryScoped(auth.householdId, input, db);
}

export async function renameCategoryGroupScoped(
  householdId: string,
  groupId: string,
  name: string,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsedId = idSchema.safeParse(groupId);
  const parsedName = nameSchema.safeParse(name);
  if (!parsedId.success || !parsedName.success) return { error: "Invalid input." };

  if (await groupNameTaken(householdId, parsedName.data, db, parsedId.data)) {
    return { error: "A category group with that name already exists." };
  }

  const scoped = scopedQuery(householdId, db);
  const updated = await db
    .update(categoryGroups)
    .set({ name: parsedName.data })
    .where(scoped.where(categoryGroups, eq(categoryGroups.id, parsedId.data)))
    .returning({ id: categoryGroups.id });

  if (updated.length === 0) return { error: "Category group not found." };
  revalidateCategoryConsumers();
  return { success: true };
}

export async function renameCategoryGroup(
  groupId: string,
  name: string,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return renameCategoryGroupScoped(auth.householdId, groupId, name, db);
}

export async function renameCategoryScoped(
  householdId: string,
  categoryId: string,
  name: string,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsedId = idSchema.safeParse(categoryId);
  const parsedName = nameSchema.safeParse(name);
  if (!parsedId.success || !parsedName.success) return { error: "Invalid input." };

  if (await categoryNameTaken(householdId, parsedName.data, db, parsedId.data)) {
    return { error: "A category with that name already exists." };
  }

  const scoped = scopedQuery(householdId, db);
  const updated = await db
    .update(categories)
    .set({ name: parsedName.data })
    .where(scoped.where(categories, eq(categories.id, parsedId.data)))
    .returning({ id: categories.id });

  if (updated.length === 0) return { error: "Category not found." };
  revalidateCategoryConsumers();
  return { success: true };
}

export async function renameCategory(
  categoryId: string,
  name: string,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return renameCategoryScoped(auth.householdId, categoryId, name, db);
}

export async function updateCategoryReportingScoped(
  householdId: string,
  categoryId: string,
  includeTransferInSpending: boolean,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsedId = idSchema.safeParse(categoryId);
  if (!parsedId.success) return { error: "Invalid input." };
  const scoped = scopedQuery(householdId, db);
  const updated = await db
    .update(categories)
    .set({ includeTransferInSpending })
    .where(
      scoped.where(
        categories,
        eq(categories.id, parsedId.data),
        eq(categories.isSystem, false),
      ),
    )
    .returning({ id: categories.id });
  if (updated.length === 0) return { error: "Only custom categories can be changed." };
  revalidateCategoryConsumers();
  return { success: true };
}

export async function updateCategoryReporting(
  categoryId: string,
  includeTransferInSpending: boolean,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return updateCategoryReportingScoped(
    auth.householdId,
    categoryId,
    includeTransferInSpending,
    db,
  );
}

export async function updateCategoryExclusionScoped(
  householdId: string,
  categoryId: string,
  excludeFromSpending: boolean,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsedId = idSchema.safeParse(categoryId);
  if (!parsedId.success) return { error: "Invalid input." };
  const scoped = scopedQuery(householdId, db);
  const updated = await db
    .update(categories)
    .set({ excludeFromSpending })
    .where(
      scoped.where(
        categories,
        eq(categories.id, parsedId.data),
        eq(categories.isSystem, false),
        eq(categories.isIncome, false),
      ),
    )
    .returning({ id: categories.id });
  if (updated.length === 0) return { error: "Only custom, non-income categories can be changed." };
  revalidateCategoryConsumers();
  return { success: true };
}

export async function updateCategoryExclusion(
  categoryId: string,
  excludeFromSpending: boolean,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return updateCategoryExclusionScoped(auth.householdId, categoryId, excludeFromSpending, db);
}

const iconSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .max(40)
  .nullable();

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable();

export async function updateCategoryColorScoped(
  householdId: string,
  categoryId: string,
  color: string | null,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsedId = idSchema.safeParse(categoryId);
  const parsedColor = colorSchema.safeParse(color);
  if (!parsedId.success || !parsedColor.success) return { error: "Invalid input." };
  const scoped = scopedQuery(householdId, db);
  const updated = await db
    .update(categories)
    .set({ color: parsedColor.data })
    .where(scoped.where(categories, eq(categories.id, parsedId.data)))
    .returning({ id: categories.id });
  if (updated.length === 0) return { error: "Category not found." };
  revalidateCategoryConsumers();
  return { success: true };
}

export async function updateCategoryColor(
  categoryId: string,
  color: string | null,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return updateCategoryColorScoped(auth.householdId, categoryId, color, db);
}

export async function updateCategoryIconScoped(
  householdId: string,
  categoryId: string,
  icon: string | null,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsedId = idSchema.safeParse(categoryId);
  const parsedIcon = iconSchema.safeParse(icon);
  if (!parsedId.success || !parsedIcon.success) return { error: "Invalid input." };
  const scoped = scopedQuery(householdId, db);
  const updated = await db
    .update(categories)
    .set({ icon: parsedIcon.data })
    .where(scoped.where(categories, eq(categories.id, parsedId.data)))
    .returning({ id: categories.id });
  if (updated.length === 0) return { error: "Category not found." };
  revalidateCategoryConsumers();
  return { success: true };
}

export async function updateCategoryIcon(
  categoryId: string,
  icon: string | null,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return updateCategoryIconScoped(auth.householdId, categoryId, icon, db);
}

export async function updateCategoryGroupIconScoped(
  householdId: string,
  groupId: string,
  icon: string | null,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsedId = idSchema.safeParse(groupId);
  const parsedIcon = iconSchema.safeParse(icon);
  if (!parsedId.success || !parsedIcon.success) return { error: "Invalid input." };
  const scoped = scopedQuery(householdId, db);
  const updated = await db
    .update(categoryGroups)
    .set({ icon: parsedIcon.data })
    .where(scoped.where(categoryGroups, eq(categoryGroups.id, parsedId.data)))
    .returning({ id: categoryGroups.id });
  if (updated.length === 0) return { error: "Category group not found." };
  revalidateCategoryConsumers();
  return { success: true };
}

export async function updateCategoryGroupColorScoped(
  householdId: string,
  groupId: string,
  color: string | null,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsedId = idSchema.safeParse(groupId);
  const parsedColor = colorSchema.safeParse(color);
  if (!parsedId.success || !parsedColor.success) return { error: "Invalid input." };
  const scoped = scopedQuery(householdId, db);
  const updated = await db
    .update(categoryGroups)
    .set({ color: parsedColor.data })
    .where(scoped.where(categoryGroups, eq(categoryGroups.id, parsedId.data)))
    .returning({ id: categoryGroups.id });
  if (updated.length === 0) return { error: "Category group not found." };
  revalidateCategoryConsumers();
  return { success: true };
}

export async function updateCategoryGroupColor(
  groupId: string,
  color: string | null,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return updateCategoryGroupColorScoped(auth.householdId, groupId, color, db);
}

export async function updateCategoryGroupIcon(
  groupId: string,
  icon: string | null,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return updateCategoryGroupIconScoped(auth.householdId, groupId, icon, db);
}

export async function moveCategoryToGroupScoped(
  householdId: string,
  categoryId: string,
  groupId: string,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsedId = idSchema.safeParse(categoryId);
  const parsedGroup = idSchema.safeParse(groupId);
  if (!parsedId.success || !parsedGroup.success) return { error: "Invalid input." };
  const group = await getOwnedGroup(householdId, parsedGroup.data, db);
  if (!group) return { error: "Category group not found." };

  const scoped = scopedQuery(householdId, db);
  const [last] = await db
    .select({ sortOrder: categories.sortOrder })
    .from(categories)
    .where(scoped.where(categories, eq(categories.groupId, parsedGroup.data)))
    .orderBy(desc(categories.sortOrder))
    .limit(1);
  const updated = await db
    .update(categories)
    .set({ groupId: parsedGroup.data, sortOrder: (last?.sortOrder ?? -1) + 1 })
    .where(scoped.where(categories, eq(categories.id, parsedId.data)))
    .returning({ id: categories.id });
  if (updated.length === 0) return { error: "Category not found." };
  revalidateCategoryConsumers();
  return { success: true };
}

export async function moveCategoryToGroup(
  categoryId: string,
  groupId: string,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return moveCategoryToGroupScoped(auth.householdId, categoryId, groupId, db);
}

type MergeResult = { success: true; moved: number } | { error: string };

/** Seeded categories carry one or more original names, joined by "|", for the PFC map. */
function joinSystemKeys(...keys: (string | null)[]): string | null {
  const all = keys.flatMap((key) => (key ? key.split("|") : []));
  return all.length > 0 ? [...new Set(all)].join("|") : null;
}

/**
 * Folds `sourceId` into `targetId`: every transaction, split, rule, merchant
 * default, recurring item and budget line that pointed at the source now points
 * at the target, then the source is deleted. Budget lines for the same budget
 * are summed. The target keeps its own name, icon and reporting flags; if the
 * source was a seeded category, the target inherits its Plaid PFC mapping.
 */
export async function mergeCategoriesScoped(
  householdId: string,
  sourceId: string,
  targetId: string,
  db: LedgrDb = defaultDb,
): Promise<MergeResult> {
  const parsedSource = idSchema.safeParse(sourceId);
  const parsedTarget = idSchema.safeParse(targetId);
  if (!parsedSource.success || !parsedTarget.success) return { error: "Invalid input." };
  if (parsedSource.data === parsedTarget.data) {
    return { error: "Choose two different categories to merge." };
  }

  const scoped = scopedQuery(householdId, db);
  const owned = await db
    .select({
      id: categories.id,
      isIncome: categories.isIncome,
      systemKey: categories.systemKey,
    })
    .from(categories)
    .where(scoped.where(categories));
  const source = owned.find((row) => row.id === parsedSource.data);
  const target = owned.find((row) => row.id === parsedTarget.data);
  if (!source || !target) return { error: "Category not found." };
  if (Boolean(source.isIncome) !== Boolean(target.isIncome)) {
    return { error: "Income and expense categories cannot be merged together." };
  }

  const moved = await db.transaction(async (tx) => {
    const txScoped = scopedQuery(householdId, tx as unknown as LedgrDb);

    const movedTxns = await tx
      .update(transactions)
      .set({ categoryId: target.id })
      .where(txScoped.where(transactions, eq(transactions.categoryId, source.id)))
      .returning({ id: transactions.id });

    const splitIds = await tx
      .select({ id: transactionSplits.id })
      .from(transactionSplits)
      .innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
      .where(txScoped.where(transactions, eq(transactionSplits.categoryId, source.id)));
    if (splitIds.length > 0) {
      await tx
        .update(transactionSplits)
        .set({ categoryId: target.id })
        .where(inArray(transactionSplits.id, splitIds.map((row) => row.id)));
    }

    await tx
      .update(categoryRules)
      .set({ categoryId: target.id })
      .where(txScoped.where(categoryRules, eq(categoryRules.categoryId, source.id)));
    await tx
      .update(merchants)
      .set({ categoryId: target.id })
      .where(txScoped.where(merchants, eq(merchants.categoryId, source.id)));
    await tx
      .update(recurringTransactions)
      .set({ categoryId: target.id })
      .where(
        txScoped.where(recurringTransactions, eq(recurringTransactions.categoryId, source.id)),
      );

    // Budget lines: one row per (budget, category), so fold duplicates together.
    const sourceLines = await tx
      .select({
        id: budgetCategories.id,
        budgetId: budgetCategories.budgetId,
        limitAmount: budgetCategories.limitAmount,
      })
      .from(budgetCategories)
      .innerJoin(budgets, eq(budgetCategories.budgetId, budgets.id))
      .where(txScoped.where(budgets, eq(budgetCategories.categoryId, source.id)));
    for (const line of sourceLines) {
      const [existing] = await tx
        .select({ id: budgetCategories.id, limitAmount: budgetCategories.limitAmount })
        .from(budgetCategories)
        .where(
          and(
            eq(budgetCategories.budgetId, line.budgetId),
            eq(budgetCategories.categoryId, target.id),
          ),
        )
        .limit(1);
      if (existing) {
        await tx
          .update(budgetCategories)
          .set({ limitAmount: existing.limitAmount + line.limitAmount })
          .where(eq(budgetCategories.id, existing.id));
        await tx.delete(budgetCategories).where(eq(budgetCategories.id, line.id));
      } else {
        await tx
          .update(budgetCategories)
          .set({ categoryId: target.id })
          .where(eq(budgetCategories.id, line.id));
      }
    }

    await tx
      .update(categories)
      .set({ systemKey: joinSystemKeys(target.systemKey, source.systemKey) })
      .where(txScoped.where(categories, eq(categories.id, target.id)));
    await tx
      .delete(categories)
      .where(txScoped.where(categories, eq(categories.id, source.id)));

    return movedTxns.length;
  });

  revalidateCategoryConsumers();
  return { success: true, moved };
}

export async function mergeCategories(
  sourceId: string,
  targetId: string,
  db: LedgrDb = defaultDb,
): Promise<MergeResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return mergeCategoriesScoped(auth.householdId, sourceId, targetId, db);
}

/** Moves every category in `sourceId` into `targetId`, then deletes the emptied group. */
export async function mergeCategoryGroupsScoped(
  householdId: string,
  sourceId: string,
  targetId: string,
  db: LedgrDb = defaultDb,
): Promise<MergeResult> {
  const parsedSource = idSchema.safeParse(sourceId);
  const parsedTarget = idSchema.safeParse(targetId);
  if (!parsedSource.success || !parsedTarget.success) return { error: "Invalid input." };
  if (parsedSource.data === parsedTarget.data) {
    return { error: "Choose two different groups to merge." };
  }
  const source = await getOwnedGroup(householdId, parsedSource.data, db);
  const target = await getOwnedGroup(householdId, parsedTarget.data, db);
  if (!source || !target) return { error: "Category group not found." };

  const moved = await db.transaction(async (tx) => {
    const txScoped = scopedQuery(householdId, tx as unknown as LedgrDb);
    const [last] = await tx
      .select({ sortOrder: categories.sortOrder })
      .from(categories)
      .where(txScoped.where(categories, eq(categories.groupId, target.id)))
      .orderBy(desc(categories.sortOrder))
      .limit(1);
    const children = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(txScoped.where(categories, eq(categories.groupId, source.id)))
      .orderBy(categories.sortOrder);
    let next = (last?.sortOrder ?? -1) + 1;
    for (const child of children) {
      await tx
        .update(categories)
        .set({ groupId: target.id, sortOrder: next++ })
        .where(eq(categories.id, child.id));
    }
    await tx
      .delete(categoryGroups)
      .where(txScoped.where(categoryGroups, eq(categoryGroups.id, source.id)));
    return children.length;
  });

  revalidateCategoryConsumers();
  return { success: true, moved };
}

export async function mergeCategoryGroups(
  sourceId: string,
  targetId: string,
  db: LedgrDb = defaultDb,
): Promise<MergeResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return mergeCategoryGroupsScoped(auth.householdId, sourceId, targetId, db);
}

async function categoryHasDependencies(
  householdId: string,
  categoryId: string,
  db: LedgrDb,
): Promise<boolean> {
  const scoped = scopedQuery(householdId, db);

  const [transaction, split, rule, merchant, budget, recurring] = await Promise.all([
    db
      .select({ id: transactions.id })
      .from(transactions)
      .where(scoped.where(transactions, eq(transactions.categoryId, categoryId)))
      .limit(1),
    db
      .select({ id: transactionSplits.id })
      .from(transactionSplits)
      .innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
      .where(scoped.where(transactions, eq(transactionSplits.categoryId, categoryId)))
      .limit(1),
    db
      .select({ id: categoryRules.id })
      .from(categoryRules)
      .where(scoped.where(categoryRules, eq(categoryRules.categoryId, categoryId)))
      .limit(1),
    db
      .select({ id: merchants.id })
      .from(merchants)
      .where(scoped.where(merchants, eq(merchants.categoryId, categoryId)))
      .limit(1),
    db
      .select({ id: budgetCategories.id })
      .from(budgetCategories)
      .innerJoin(budgets, eq(budgetCategories.budgetId, budgets.id))
      .where(scoped.where(budgets, eq(budgetCategories.categoryId, categoryId)))
      .limit(1),
    db
      .select({ id: recurringTransactions.id })
      .from(recurringTransactions)
      .where(scoped.where(recurringTransactions, eq(recurringTransactions.categoryId, categoryId)))
      .limit(1),
  ]);

  return [transaction, split, rule, merchant, budget, recurring].some((rows) => rows.length > 0);
}

export async function deleteCategoryScoped(
  householdId: string,
  categoryId: string,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsed = idSchema.safeParse(categoryId);
  if (!parsed.success) return { error: "Invalid input." };

  const category = await getOwnedCategory(householdId, parsed.data, db);
  if (!category) return { error: "Category not found." };
  if (category.isSystem) return { error: "System categories cannot be deleted." };
  if (await categoryHasDependencies(householdId, parsed.data, db)) {
    return { error: "This category is in use and cannot be deleted." };
  }

  const scoped = scopedQuery(householdId, db);
  await db
    .delete(categories)
    .where(scoped.where(categories, eq(categories.id, parsed.data), eq(categories.isSystem, false)));

  revalidateCategoryConsumers();
  return { success: true };
}

export async function deleteCategory(
  categoryId: string,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return deleteCategoryScoped(auth.householdId, categoryId, db);
}

export async function deleteCategoryGroupScoped(
  householdId: string,
  groupId: string,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsed = idSchema.safeParse(groupId);
  if (!parsed.success) return { error: "Invalid input." };

  const group = await getOwnedGroup(householdId, parsed.data, db);
  if (!group) return { error: "Category group not found." };
  if (group.isSystem) return { error: "System category groups cannot be deleted." };

  const scoped = scopedQuery(householdId, db);
  const [child] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(scoped.where(categories, eq(categories.groupId, parsed.data)))
    .limit(1);
  if (child) return { error: "Delete or move the categories in this group first." };

  await db
    .delete(categoryGroups)
    .where(
      scoped.where(
        categoryGroups,
        eq(categoryGroups.id, parsed.data),
        eq(categoryGroups.isSystem, false),
      ),
    );

  revalidateCategoryConsumers();
  return { success: true };
}

export async function deleteCategoryGroup(
  groupId: string,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return deleteCategoryGroupScoped(auth.householdId, groupId, db);
}
