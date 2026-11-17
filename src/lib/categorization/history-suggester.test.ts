import { describe, it, expect } from "vitest";
import {
  normalizeDescriptor,
  buildHistoryIndex,
  suggestFromHistory,
  suggestRulePattern,
  MIN_SUPPORT,
  MIN_SHARE,
} from "./history-suggester";

describe("normalizeDescriptor", () => {
  it("lowercases and drops store numbers, ids and punctuation", () => {
    expect(normalizeDescriptor("CASEY'S #4471 FAYETTEVILLE AR")).toBe("casey s fayetteville ar");
    expect(normalizeDescriptor("  Kum & Go  0123 ")).toBe("kum go");
  });

  it("drops payment-processor prefixes", () => {
    expect(normalizeDescriptor("SQ *BLUE BOTTLE COFFEE")).toBe("blue bottle coffee");
    expect(normalizeDescriptor("TST* Joe's Diner")).toBe("joe s diner");
    expect(normalizeDescriptor("PAYPAL *SPOTIFY")).toBe("spotify");
  });

  it("returns an empty string when nothing meaningful is left", () => {
    expect(normalizeDescriptor("#### 1234")).toBe("");
  });
});

describe("suggestFromHistory", () => {
  const rows = (n: number, name: string, categoryId: string) =>
    Array.from({ length: n }, () => ({ name, categoryId }));

  it("suggests the category the household picked every time for that merchant", () => {
    const index = buildHistoryIndex(rows(4, "CASEYS #12", "gas"));
    const s = suggestFromHistory("CASEYS #99", index);
    expect(s).toMatchObject({ categoryId: "gas", support: 4, total: 4 });
    expect(s!.confidence).toBeGreaterThan(0.8);
  });

  it(`stays quiet below ${MIN_SUPPORT} past examples`, () => {
    const index = buildHistoryIndex(rows(MIN_SUPPORT - 1, "Hobby Lobby", "home"));
    expect(suggestFromHistory("Hobby Lobby", index)).toBeNull();
  });

  it(`stays quiet when the past choices disagree (share below ${MIN_SHARE})`, () => {
    const index = buildHistoryIndex([
      ...rows(3, "Amazon", "shopping"),
      ...rows(3, "Amazon", "groceries"),
    ]);
    expect(suggestFromHistory("Amazon", index)).toBeNull();
  });

  it("goes with a clear majority and reports the split", () => {
    const index = buildHistoryIndex([...rows(9, "Walmart", "groceries"), ...rows(1, "Walmart", "home")]);
    const s = suggestFromHistory("WALMART #55", index);
    expect(s).toMatchObject({ categoryId: "groceries", support: 9, total: 10 });
  });

  it("returns null for a descriptor with no history or no usable text", () => {
    const index = buildHistoryIndex(rows(5, "Netflix", "subs"));
    expect(suggestFromHistory("Brand New Place", index)).toBeNull();
    expect(suggestFromHistory("#### 99", index)).toBeNull();
  });

  it("ignores history rows with a blank descriptor", () => {
    const index = buildHistoryIndex(rows(5, "### 12", "x"));
    expect(index.size).toBe(0);
  });
});

describe("suggestRulePattern", () => {
  it("keeps the leading words before a store number or symbol", () => {
    expect(suggestRulePattern("CASEYS #4471 FAYETTEVILLE")).toBe("CASEYS");
    expect(suggestRulePattern("Hobby Lobby 0123")).toBe("Hobby Lobby");
    expect(suggestRulePattern("SQ *Blue Bottle")).toBe("Blue Bottle");
  });

  it("returns null when the leading text is too short to be a safe rule", () => {
    expect(suggestRulePattern("7-ELEVEN 1234")).toBeNull();
    expect(suggestRulePattern("#### 1234")).toBeNull();
  });
});
