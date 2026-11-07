import { and, eq, inArray } from "drizzle-orm";
import { categories, transactionCategorySuggestions, transactions } from "@/db/schema";
import { withHousehold } from "@/lib/household-context";

/** Cached suggestion per transaction id; null = answered with nothing to suggest. Unknown ids are absent. */
export async function getCategorySuggestions(
  householdId: string,
  ids: string[],
): Promise<Record<string, string | null>> {
  if (ids.length === 0) return {};
  const rows = await withHousehold(householdId, (tx) =>
    tx
      .select({ id: transactionCategorySuggestions.transactionId, categoryId: transactionCategorySuggestions.categoryId })
      .from(transactionCategorySuggestions)
      .where(
        and(
          eq(transactionCategorySuggestions.householdId, householdId),
          inArray(transactionCategorySuggestions.transactionId, ids),
        ),
      ),
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.categoryId]));
}

/** Store (or overwrite) the cached answer for one transaction. */
export async function setCategorySuggestion(
  householdId: string,
  transactionId: string,
  categoryId: string | null,
): Promise<{ success: true } | { error: string }> {
  return withHousehold(householdId, async (tx) => {
    const [txn] = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.id, transactionId), eq(transactions.householdId, householdId)))
      .limit(1);
    if (!txn) return { error: "Transaction not found" };
    if (categoryId) {
      const [cat] = await tx
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.id, categoryId), eq(categories.householdId, householdId)))
        .limit(1);
      if (!cat) return { error: "Category not found" };
    }
    await tx
      .insert(transactionCategorySuggestions)
      .values({ transactionId, householdId, categoryId })
      .onConflictDoUpdate({
        target: transactionCategorySuggestions.transactionId,
        set: { categoryId, createdAt: new Date() },
      });
    return { success: true as const };
  });
}
