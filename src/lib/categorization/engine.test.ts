import { describe, it, expect } from "vitest";
import { test } from "@fast-check/vitest";
import * as fc from "fast-check";
import {
  categorizeTransactions,
  type CategorizableTransaction,
  type CategoryRule,
} from "./engine";
import { buildHistoryIndex } from "./history-suggester";

function makeTxn(overrides: Partial<CategorizableTransaction> = {}): CategorizableTransaction {
  return {
    id: "txn-1",
    name: "Whole Foods Market",
    merchantId: null,
    merchantName: null,
    merchantCategoryId: null,
    pfcDetailed: null,
    ...overrides,
  };
}

function makeRule(overrides: Partial<CategoryRule> = {}): CategoryRule {
  return {
    id: "rule-1",
    categoryId: "cat-groceries",
    matchField: "name",
    matchPattern: "whole foods",
    priority: 0,
    ...overrides,
  };
}

describe("categorizeTransactions", () => {
  it("matches a name rule (case-insensitive substring)", () => {
    const txns = [makeTxn({ name: "WHOLE FOODS MARKET #123" })];
    const rules = [makeRule({ matchPattern: "whole foods" })];

    const result = categorizeTransactions(txns, rules);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      transactionId: "txn-1",
      categoryId: "cat-groceries",
      source: "rule",
    });
  });

  it("matches a merchant rule against merchantName", () => {
    const txns = [makeTxn({ merchantName: "Spotify", merchantId: "m-1" })];
    const rules = [makeRule({ matchField: "merchant", matchPattern: "spotify", categoryId: "cat-subs" })];

    const result = categorizeTransactions(txns, rules);

    expect(result).toHaveLength(1);
    expect(result[0].categoryId).toBe("cat-subs");
    expect(result[0].source).toBe("rule");
  });

  it("higher priority rule wins over lower", () => {
    const txns = [makeTxn({ name: "Starbucks Coffee" })];
    const rules = [
      makeRule({ id: "r-low", matchPattern: "starbucks", categoryId: "cat-dining", priority: 0 }),
      makeRule({ id: "r-high", matchPattern: "starbucks", categoryId: "cat-coffee", priority: 10 }),
    ];

    const result = categorizeTransactions(txns, rules);

    expect(result).toHaveLength(1);
    expect(result[0].categoryId).toBe("cat-coffee");
  });

  it("falls back to merchant default when no rule matches", () => {
    const txns = [makeTxn({ name: "XYZ Corp", merchantCategoryId: "cat-misc", merchantId: "m-1" })];
    const rules = [makeRule({ matchPattern: "no-match" })];

    const result = categorizeTransactions(txns, rules);

    expect(result).toHaveLength(1);
    expect(result[0].categoryId).toBe("cat-misc");
    expect(result[0].source).toBe("merchant_default");
  });

  it("returns empty array when nothing matches and no merchant default", () => {
    const txns = [makeTxn({ name: "Unknown Store" })];
    const rules = [makeRule({ matchPattern: "no-match" })];

    const result = categorizeTransactions(txns, rules);

    expect(result).toHaveLength(0);
  });

  it("returns empty array when rules list is empty", () => {
    const txns = [makeTxn()];

    const result = categorizeTransactions(txns, []);

    expect(result).toHaveLength(0);
  });

  // Property-based tests
  test.prop(
    [
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 0, max: 100 }),
    ],
  )("higher priority always wins regardless of insertion order", (pA, pB) => {
    fc.pre(pA !== pB);
    const highPriority = Math.max(pA, pB);
    const lowPriority = Math.min(pA, pB);
    const txns = [makeTxn({ name: "test" })];
    const rules = [
      makeRule({ id: "r-low", matchPattern: "test", categoryId: "cat-low", priority: lowPriority }),
      makeRule({ id: "r-high", matchPattern: "test", categoryId: "cat-high", priority: highPriority }),
    ];

    const result = categorizeTransactions(txns, rules);

    expect(result).toHaveLength(1);
    expect(result[0].categoryId).toBe("cat-high");
  });

  test.prop(
    [fc.array(fc.record({ name: fc.string({ minLength: 1 }) }), { minLength: 1, maxLength: 20 })],
  )("output length never exceeds input length", (rawTxns) => {
    const txns = rawTxns.map((t, i) => makeTxn({ id: `txn-${i}`, name: t.name }));
    const rules = [makeRule({ matchPattern: "a" })];

    const result = categorizeTransactions(txns, rules);

    expect(result.length).toBeLessThanOrEqual(txns.length);
  });

  it("falls back to PFC mapping when no rule or merchant default matches", () => {
    const pfcMap = new Map([["FOOD_AND_DRINK_GROCERIES", "cat-groceries"]]);
    const txns = [makeTxn({ name: "Random Store", pfcDetailed: "FOOD_AND_DRINK_GROCERIES" })];
    const rules = [makeRule({ matchPattern: "no-match" })];

    const result = categorizeTransactions(txns, rules, pfcMap);

    expect(result).toHaveLength(1);
    expect(result[0].categoryId).toBe("cat-groceries");
    expect(result[0].source).toBe("pfc");
  });

  it("rule takes priority over PFC mapping", () => {
    const pfcMap = new Map([["FOOD_AND_DRINK_GROCERIES", "cat-pfc"]]);
    const txns = [makeTxn({ name: "Whole Foods", pfcDetailed: "FOOD_AND_DRINK_GROCERIES" })];
    const rules = [makeRule({ matchPattern: "whole foods", categoryId: "cat-rule" })];

    const result = categorizeTransactions(txns, rules, pfcMap);

    expect(result).toHaveLength(1);
    expect(result[0].categoryId).toBe("cat-rule");
    expect(result[0].source).toBe("rule");
  });

  it("merchant default takes priority over PFC mapping", () => {
    const pfcMap = new Map([["FOOD_AND_DRINK_GROCERIES", "cat-pfc"]]);
    const txns = [makeTxn({
      name: "Unknown",
      merchantCategoryId: "cat-merchant",
      merchantId: "m-1",
      pfcDetailed: "FOOD_AND_DRINK_GROCERIES",
    })];

    const result = categorizeTransactions(txns, [], pfcMap);

    expect(result).toHaveLength(1);
    expect(result[0].categoryId).toBe("cat-merchant");
    expect(result[0].source).toBe("merchant_default");
  });

  it("skips PFC mapping when pfcDetailed is null", () => {
    const pfcMap = new Map([["FOOD_AND_DRINK_GROCERIES", "cat-pfc"]]);
    const txns = [makeTxn({ name: "Unknown", pfcDetailed: null })];

    const result = categorizeTransactions(txns, [], pfcMap);

    expect(result).toHaveLength(0);
  });

  it("skips PFC mapping when pfcDetailed is not in the map", () => {
    const pfcMap = new Map([["FOOD_AND_DRINK_GROCERIES", "cat-pfc"]]);
    const txns = [makeTxn({ name: "Unknown", pfcDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER" })];

    const result = categorizeTransactions(txns, [], pfcMap);

    expect(result).toHaveLength(0);
  });

  it("works with empty PFC map (backward compatible)", () => {
    const txns = [makeTxn({ name: "Store", pfcDetailed: "FOOD_AND_DRINK_GROCERIES" })];

    const result = categorizeTransactions(txns, []);

    expect(result).toHaveLength(0);
  });
});

describe("categorizeTransactions: history tier", () => {
  const history = buildHistoryIndex([
    { name: "CASEYS #12", categoryId: "cat-gas" },
    { name: "CASEYS #30", categoryId: "cat-gas" },
    { name: "CASEYS #44", categoryId: "cat-gas" },
  ]);

  it("files a known merchant under the household's usual category, as a guess", () => {
    const result = categorizeTransactions([makeTxn({ name: "CASEYS #901" })], [], new Map(), history);

    expect(result).toEqual([{ transactionId: "txn-1", categoryId: "cat-gas", source: "history" }]);
  });

  it("loses to a rule and to a merchant default", () => {
    const rule = makeRule({ matchPattern: "caseys", categoryId: "cat-rule" });
    expect(categorizeTransactions([makeTxn({ name: "CASEYS #901" })], [rule], new Map(), history)[0].source).toBe("rule");

    const withDefault = makeTxn({ name: "CASEYS #901", merchantCategoryId: "cat-merchant" });
    expect(categorizeTransactions([withDefault], [], new Map(), history)[0]).toMatchObject({
      categoryId: "cat-merchant",
      source: "merchant_default",
    });
  });

  it("beats the bank's PFC label", () => {
    const pfc = new Map([["TRANSPORTATION_GAS", "cat-pfc"]]);
    const txn = makeTxn({ name: "CASEYS #901", pfcDetailed: "TRANSPORTATION_GAS" });

    expect(categorizeTransactions([txn], [], pfc, history)[0]).toMatchObject({
      categoryId: "cat-gas",
      source: "history",
    });
  });

  it("falls through to PFC when history has nothing for the merchant", () => {
    const pfc = new Map([["TRANSPORTATION_GAS", "cat-pfc"]]);
    const txn = makeTxn({ name: "Some New Station", pfcDetailed: "TRANSPORTATION_GAS" });

    expect(categorizeTransactions([txn], [], pfc, history)[0].source).toBe("pfc");
  });
});
