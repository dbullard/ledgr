import { describe, test, expect } from "vitest";
import {
  allocateSplits,
  applyAliases,
  cleanItems,
  normalizeRawName,
  reconcile,
} from "../../src/lib/receipts/items";

const cats = [
  { id: "c-groc", name: "Groceries" },
  { id: "c-home", name: "Home Goods" },
];

describe("cleanItems", () => {
  test("drops junk lines, snaps categories, converts quantity, keeps discounts", () => {
    const items = cleanItems(
      {
        items: [
          { name: " KS ORG  BNNA ", quantity: 1.5, totalCents: 349, product: "Bananas", category: "groceries" },
          { name: "", totalCents: 100 },
          { name: "FREE SAMPLE", totalCents: 0 },
          { name: "COUPON", totalCents: -100, category: "Nonexistent" },
          { name: "DISH SOAP", totalCents: 499.4, category: "Home Goods" },
        ],
      },
      cats,
    );
    expect(items).toEqual([
      { rawName: "KS ORG BNNA", productName: "Bananas", categoryId: "c-groc", quantityMilli: 1500, totalCents: 349 },
      { rawName: "COUPON", productName: null, categoryId: null, quantityMilli: 1000, totalCents: -100 },
      { rawName: "DISH SOAP", productName: null, categoryId: "c-home", quantityMilli: 1000, totalCents: 499 },
    ]);
  });
});

describe("aliases", () => {
  test("normalizes raw names", () => {
    expect(normalizeRawName("KS  ORG-BNNA, 3LB")).toBe("ks org bnna 3lb");
  });
  test("a confirmed alias overrides the model's guess", () => {
    const [item] = applyAliases(
      [{ rawName: "KS ORG BNNA", productName: "Banana", categoryId: "c-home", quantityMilli: 1000, totalCents: 349 }],
      [{ rawKey: "ks org bnna", productName: "Bananas", categoryId: "c-groc" }],
    );
    expect(item).toMatchObject({ productName: "Bananas", categoryId: "c-groc" });
  });
});

describe("reconcile and allocateSplits", () => {
  test("gap is the receipt total minus the lines", () => {
    expect(reconcile([{ totalCents: 1000 }, { totalCents: 500 }], 1620)).toEqual({ itemsTotalCents: 1500, gapCents: 120 });
    expect(reconcile([{ totalCents: 1 }], null).gapCents).toBeNull();
  });

  test("splits sum exactly to the transaction and spread tax proportionally", () => {
    const splits = allocateSplits(
      [
        { categoryId: "c-groc", totalCents: 3000 },
        { categoryId: "c-groc", totalCents: 1000 },
        { categoryId: "c-home", totalCents: 1000 },
        { categoryId: null, totalCents: 777 },
      ],
      5333,
    );
    expect(splits).toEqual([
      { categoryId: "c-groc", amount: 4266 },
      { categoryId: "c-home", amount: 1067 },
    ]);
    expect(splits!.reduce((s, x) => s + x.amount, 0)).toBe(5333);
  });

  test("never loses a cent to rounding", () => {
    const splits = allocateSplits(
      [
        { categoryId: "a", totalCents: 1 },
        { categoryId: "b", totalCents: 1 },
        { categoryId: "c", totalCents: 1 },
      ],
      100,
    )!;
    expect(splits.reduce((s, x) => s + x.amount, 0)).toBe(100);
  });

  test("null when nothing is categorized", () => {
    expect(allocateSplits([{ categoryId: null, totalCents: 100 }], 100)).toBeNull();
  });
});
