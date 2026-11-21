import { describe, expect, it } from "vitest";
import { showsReceiptMark } from "../../src/lib/receipts/mark";

describe("showsReceiptMark", () => {
  it("marks a row that has a receipt attached", () => {
    expect(showsReceiptMark({ hasReceipt: true })).toBe(true);
  });

  it("leaves a row with no receipt unmarked", () => {
    expect(showsReceiptMark({ hasReceipt: false })).toBe(false);
  });

  it("stays quiet when the list did not compute the flag", () => {
    expect(showsReceiptMark({})).toBe(false);
    expect(showsReceiptMark({ hasReceipt: undefined })).toBe(false);
  });
});
