"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { db as defaultDb, type LedgrDb } from "@/db";
import { categoryRules, categories } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { authorizeAction } from "@/lib/auth/authorize-action";
import { normalizeRulePattern } from "@/lib/categorization/rule-pattern";
import { applyRuleToTargets, countRuleTargets, type RuleTarget } from "@/lib/categorization/apply-rule";
import { withHousehold } from "@/lib/household-context";

type ActionResult = { success: true } | { error: string };

// Pattern validity lives in normalizeRulePattern, which explains why an empty
// pattern is dangerous and is unit-tested without a database.
const ruleInputSchema = z.object({
  categoryId: z.string().min(1),
  matchField: z.enum(["name", "merchant"]),
  matchPattern: z
    .string()
    .transform(normalizeRulePattern)
    .refine((p): p is string => p !== null, { message: "Enter a pattern to match on." }),
  priority: z.number().int().min(0).max(999),
});

export type CategoryRuleInput = z.input<typeof ruleInputSchema>;

const updateInputSchema = ruleInputSchema.extend({ id: z.string().min(1) });
export type CategoryRuleUpdateInput = z.input<typeof updateInputSchema>;

/**
 * A rule points at a category, so the category must belong to the same
 * household. Without this check a caller could aim a rule at another
 * household's category id and read its name back off the rules list.
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

export async function createCategoryRuleScoped(
  householdId: string,
  input: CategoryRuleInput,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsed = ruleInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Enter a pattern to match on." };

  if (!(await categoryBelongsToHousehold(householdId, parsed.data.categoryId, db))) {
    return { error: "Category not found" };
  }

  await db.insert(categoryRules).values({
    id: uuid(),
    householdId,
    categoryId: parsed.data.categoryId,
    matchField: parsed.data.matchField,
    matchPattern: parsed.data.matchPattern,
    priority: parsed.data.priority,
  });

  revalidatePath("/settings/rules");
  return { success: true };
}

export async function createCategoryRule(
  input: CategoryRuleInput,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return createCategoryRuleScoped(auth.householdId, input, db);
}

export async function updateCategoryRuleScoped(
  householdId: string,
  input: CategoryRuleUpdateInput,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsed = updateInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Enter a pattern to match on." };

  if (!(await categoryBelongsToHousehold(householdId, parsed.data.categoryId, db))) {
    return { error: "Category not found" };
  }

  const scoped = scopedQuery(householdId, db);
  const updated = await db
    .update(categoryRules)
    .set({
      categoryId: parsed.data.categoryId,
      matchField: parsed.data.matchField,
      matchPattern: parsed.data.matchPattern,
      priority: parsed.data.priority,
    })
    .where(scoped.where(categoryRules, eq(categoryRules.id, parsed.data.id)))
    .returning({ id: categoryRules.id });

  if (updated.length === 0) return { error: "Rule not found" };

  revalidatePath("/settings/rules");
  return { success: true };
}

export async function updateCategoryRule(
  input: CategoryRuleUpdateInput,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return updateCategoryRuleScoped(auth.householdId, input, db);
}

export async function deleteCategoryRuleScoped(
  householdId: string,
  ruleId: string,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsed = z.string().min(1).safeParse(ruleId);
  if (!parsed.success) return { error: "Invalid input" };

  const scoped = scopedQuery(householdId, db);
  const deleted = await db
    .delete(categoryRules)
    .where(scoped.where(categoryRules, eq(categoryRules.id, parsed.data)))
    .returning({ id: categoryRules.id });

  if (deleted.length === 0) return { error: "Rule not found" };

  revalidatePath("/settings/rules");
  return { success: true };
}

export async function deleteCategoryRule(
  ruleId: string,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return deleteCategoryRuleScoped(auth.householdId, ruleId, db);
}

const ruleTargetSchema = ruleInputSchema.pick({ categoryId: true, matchField: true, matchPattern: true });
export type RuleTargetInput = z.input<typeof ruleTargetSchema>;

async function parseRuleTarget(
  householdId: string,
  input: RuleTargetInput,
  db: LedgrDb,
): Promise<{ rule: RuleTarget } | { error: string }> {
  const parsed = ruleTargetSchema.safeParse(input);
  if (!parsed.success) return { error: "Enter a pattern to match on." };
  if (!(await categoryBelongsToHousehold(householdId, parsed.data.categoryId, db))) {
    return { error: "Category not found" };
  }
  return { rule: parsed.data };
}

/** How many existing uncategorized or guessed transactions a rule would file. */
export async function previewRuleApplicationScoped(
  householdId: string,
  input: RuleTargetInput,
  db: LedgrDb = defaultDb,
): Promise<{ count: number } | { error: string }> {
  const target = await parseRuleTarget(householdId, input, db);
  if ("error" in target) return target;
  return { count: await withHousehold(householdId, (tx) => countRuleTargets(householdId, target.rule, tx), db) };
}

export async function applyRuleToExistingScoped(
  householdId: string,
  input: RuleTargetInput,
  db: LedgrDb = defaultDb,
): Promise<{ updated: number } | { error: string }> {
  const target = await parseRuleTarget(householdId, input, db);
  if ("error" in target) return target;
  const updated = await withHousehold(householdId, (tx) => applyRuleToTargets(householdId, target.rule, tx), db);
  if (updated > 0) {
    revalidatePath("/transactions");
    revalidatePath("/");
  }
  return { updated };
}

export async function previewRuleApplication(
  input: RuleTargetInput,
  db: LedgrDb = defaultDb,
): Promise<{ count: number } | { error: string }> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return previewRuleApplicationScoped(auth.householdId, input, db);
}

export async function applyRuleToExisting(
  input: RuleTargetInput,
  db: LedgrDb = defaultDb,
): Promise<{ updated: number } | { error: string }> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return applyRuleToExistingScoped(auth.householdId, input, db);
}
