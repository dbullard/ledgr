import { describe, it, expect } from "vitest";
import { deriveKind, kindChangePlan, type KindCategoryGroup } from "./transaction-kind";

const groups: KindCategoryGroup[] = [
  {
    categories: [
      { id: "groceries", isIncome: false },
      { id: "salary", isIncome: true },
    ],
  },
];

describe("deriveKind", () => {
  it("is a transfer whenever the transaction is flagged, whatever the category or sign", () => {
    expect(deriveKind({ isTransfer: true, categoryId: "groceries", normalizedAmount: -500 }, groups)).toBe("transfer");
  });

  it("follows the category's side when one is set, not the amount's sign", () => {
    expect(deriveKind({ isTransfer: false, categoryId: "salary", normalizedAmount: -500 }, groups)).toBe("income");
    expect(deriveKind({ isTransfer: false, categoryId: "groceries", normalizedAmount: 500 }, groups)).toBe("expense");
  });

  it("falls back to the amount's sign without a category", () => {
    expect(deriveKind({ isTransfer: false, categoryId: null, normalizedAmount: 500 }, groups)).toBe("income");
    expect(deriveKind({ isTransfer: false, categoryId: null, normalizedAmount: -500 }, groups)).toBe("expense");
  });

  it("falls back to the sign when the category is not in the list", () => {
    expect(deriveKind({ isTransfer: false, categoryId: "gone", normalizedAmount: -1 }, groups)).toBe("expense");
  });
});

describe("kindChangePlan", () => {
  it("flags a transfer and leaves the category alone", () => {
    expect(
      kindChangePlan("transfer", { isTransfer: false, categoryId: "groceries" }, groups),
    ).toEqual({ setTransfer: true, clearCategory: false });
  });

  it("does nothing to the flag when moving from one non-transfer side to the other without a category", () => {
    expect(
      kindChangePlan("income", { isTransfer: false, categoryId: null }, groups),
    ).toEqual({ setTransfer: null, clearCategory: false });
  });

  it("unflags a transfer when switching to expense or income", () => {
    expect(
      kindChangePlan("expense", { isTransfer: true, categoryId: null }, groups),
    ).toEqual({ setTransfer: false, clearCategory: false });
  });

  it("clears a category from the other side", () => {
    expect(
      kindChangePlan("income", { isTransfer: false, categoryId: "groceries" }, groups),
    ).toEqual({ setTransfer: null, clearCategory: true });
    expect(
      kindChangePlan("expense", { isTransfer: false, categoryId: "salary" }, groups),
    ).toEqual({ setTransfer: null, clearCategory: true });
  });

  it("keeps a category that already fits the chosen side", () => {
    expect(
      kindChangePlan("expense", { isTransfer: false, categoryId: "groceries" }, groups),
    ).toEqual({ setTransfer: null, clearCategory: false });
  });
});
