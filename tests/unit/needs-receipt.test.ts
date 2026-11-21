import { describe, expect, it } from "vitest";
import { needsReceipt } from "../../src/lib/receipts/missing";

const expense = { hasReceipt: false, normalizedAmount: -2000, isTransfer: false, pending: false };

describe("needsReceipt", () => {
  it("flags a posted expense with no receipt", () => {
    expect(needsReceipt(expense)).toBe(true);
  });

  it("does not flag one that has a receipt", () => {
    expect(needsReceipt({ ...expense, hasReceipt: true })).toBe(false);
  });

  it("stays quiet when the list did not compute the flag", () => {
    expect(needsReceipt({ ...expense, hasReceipt: undefined })).toBe(false);
  });

  it("ignores income, transfers and pending charges", () => {
    expect(needsReceipt({ ...expense, normalizedAmount: 5000 })).toBe(false);
    expect(needsReceipt({ ...expense, isTransfer: true })).toBe(false);
    expect(needsReceipt({ ...expense, pending: true })).toBe(false);
  });

  it("ignores a zero-amount row", () => {
    expect(needsReceipt({ ...expense, normalizedAmount: 0 })).toBe(false);
  });
});
