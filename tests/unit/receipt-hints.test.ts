import { describe, test, expect } from "vitest";
import { extractHints, findDate, findTotal, merchantFromFilename, merchantFromFirstLine } from "../../src/lib/receipts/hints";

describe("findTotal", () => {
  test("takes the grand total, not subtotal or tax", () => {
    const text = "Item Subtotal: $68.85\nSales Tax: $6.54\nGrand Total: USD 75.39";
    expect(findTotal(text)).toBe(7539);
  });
  test("works without line breaks and with thousands separators", () => {
    expect(findTotal("Subtotal 1,100.00 Tax 88.00 Total $1,188.00 Thank you")).toBe(118800);
  });
  test("null when there is no labelled total", () => {
    expect(findTotal("Thanks for shopping 12.50")).toBeNull();
  });
});

describe("findDate", () => {
  test.each([
    ["Order Placed: November 2, 2026", "2026-11-02"],
    ["Nov 4, 2026 at 10:14 AM", "2026-11-04"],
    ["11/02/2026", "2026-11-02"],
    ["2026-11-02", "2026-11-02"],
  ])("%s", (input, expected) => {
    expect(findDate(input)).toBe(expected);
  });
  test("rejects impossible dates", () => {
    expect(findDate("2026-02-31")).toBeNull();
  });
});

describe("extractHints", () => {
  test("reads an email's sender, date and total", () => {
    const eml = "From: Spotify <no-reply@spotify.com>\nDate: Nov 4, 2026\n\nTotal $24.08";
    expect(extractHints("receipt.eml", eml)).toEqual({
      totalCents: 2408,
      date: "2026-11-04",
      merchant: "Spotify",
    });
  });
  test("falls back to the filename when there is no text", () => {
    expect(extractHints("Casey's 2026-11-01 26.24.jpg", null)).toEqual({
      totalCents: 2624,
      date: "2026-11-01",
      merchant: "Casey",
    });
  });
  test("merchantFromFilename drops dates, amounts and noise words", () => {
    expect(merchantFromFilename("IMG_receipt_Best Buy_2026-10-03_874.91.pdf")).toBe("Best Buy");
    expect(merchantFromFilename("2026-10-03.pdf")).toBeNull();
  });

  test("a text receipt's merchant is its first plausible line, not the filename", () => {
    const text = "Trader Joe's\nOrder Placed: October 27, 2026\nGrand Total: $74.33";
    expect(extractHints("tj-oct27.txt", text).merchant).toBe("Trader Joe's");
  });
  test("merchantFromFirstLine skips headers, amounts and dates", () => {
    expect(merchantFromFirstLine("RECEIPT\n11/02/2026 10:14\n$5.00\nCorner Cafe\nTotal 5.00")).toBe("Corner Cafe");
    expect(merchantFromFirstLine("12345\n$9.99")).toBeNull();
  });
});
