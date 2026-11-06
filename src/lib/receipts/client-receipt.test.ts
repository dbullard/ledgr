import { describe, expect, it } from "vitest";
import { parseClientReceipt } from "./items";

describe("parseClientReceipt", () => {
  it("accepts a receipt read on the device", () => {
    const raw = JSON.stringify({
      merchant: "Costco",
      date: "2026-11-01",
      totalCents: 4599,
      items: [{ name: "Milk", quantity: 2, totalCents: 799 }],
    });
    expect(parseClientReceipt(raw)).toMatchObject({ merchant: "Costco", totalCents: 4599 });
  });

  it("rejects missing, malformed or wrongly shaped input", () => {
    expect(parseClientReceipt(null)).toBeNull();
    expect(parseClientReceipt("")).toBeNull();
    expect(parseClientReceipt("{not json")).toBeNull();
    expect(parseClientReceipt(JSON.stringify({ items: [{ name: "x" }] }))).toBeNull();
  });

  it("caps the item count and payload size", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ name: `i${i}`, totalCents: 100 }));
    expect(parseClientReceipt(JSON.stringify({ items }))?.items).toHaveLength(300);
    expect(parseClientReceipt("x".repeat(200_001))).toBeNull();
  });
});
