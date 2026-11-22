/**
 * Expense / Income / Transfer, the three-way type the native apps show on a
 * transaction. Only `isTransfer` is stored. Income versus expense follows the
 * category (or the amount's sign until one is chosen), so changing the type
 * means flipping the flag and dropping a category that sits on the other side.
 */
export type TransactionKind = "expense" | "income" | "transfer";

export interface KindCategoryGroup {
  categories: { id: string; isIncome: boolean }[];
}

interface KindSubject {
  isTransfer: boolean;
  categoryId: string | null;
  normalizedAmount: number;
}

function findCategory(groups: KindCategoryGroup[], id: string | null) {
  if (!id) return undefined;
  for (const g of groups) {
    const hit = g.categories.find((c) => c.id === id);
    if (hit) return hit;
  }
  return undefined;
}

export function deriveKind(txn: KindSubject, groups: KindCategoryGroup[]): TransactionKind {
  if (txn.isTransfer) return "transfer";
  const category = findCategory(groups, txn.categoryId);
  if (category) return category.isIncome ? "income" : "expense";
  return txn.normalizedAmount > 0 ? "income" : "expense";
}

export interface KindChangePlan {
  /** New `isTransfer` value to save, or null to leave the flag as it is. */
  setTransfer: boolean | null;
  /** Whether the current category no longer fits and must be cleared. */
  clearCategory: boolean;
}

export function kindChangePlan(
  next: TransactionKind,
  txn: Pick<KindSubject, "isTransfer" | "categoryId">,
  groups: KindCategoryGroup[],
): KindChangePlan {
  if (next === "transfer") return { setTransfer: true, clearCategory: false };
  const category = findCategory(groups, txn.categoryId);
  return {
    setTransfer: txn.isTransfer ? false : null,
    clearCategory: Boolean(category) && category!.isIncome !== (next === "income"),
  };
}
