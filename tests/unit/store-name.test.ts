import { describe, test, expect } from "vitest";
import { expandToken, searchNormalize, searchTokens, storeLabel } from "../../src/lib/receipts/store-name";

describe("storeLabel", () => {
  test("known stores get a fixed name whatever the bank printed", () => {
    expect(storeLabel("Sams Club.com DDA PIN POS PUR CD1322 Bentonville #")).toBe("Sam's Club");
    expect(storeLabel("Samsclub.com Dda Pin Pos Pur Cd8026 Ar")).toBe("Sam's Club");
    expect(storeLabel("WM Supercenter # DDA PIN POS PUR CD8026 Roger")).toBe("Walmart");
    expect(storeLabel("Walmart.com DDA PIN POS PUR CD1322 Bentonvill")).toBe("Walmart");
  });

  test("a resolved merchant wins, otherwise bank noise is trimmed", () => {
    expect(storeLabel("Whatever", "Costco")).toBe("Costco");
    expect(storeLabel("Black Hills Enrg Util Bill David Bullard")).toBe("Black Hills Enrg Util Bill David Bullard");
    expect(storeLabel("Target Dda Pin Pos Pur Cd1322 Rogers")).toBe("Target");
  });
});

describe("search", () => {
  test("normalizes punctuation and money", () => {
    expect(searchNormalize("Sam's  Club")).toBe("sams club");
    expect(searchNormalize("$11.98")).toBe("11.98");
  });

  test("a store name also finds the spelling the bank used", () => {
    expect(expandToken("walmart")).toContain("wm supercenter");
    expect(expandToken("sam's")).toContain("samsclub");
    expect(expandToken("pizza")).toEqual(["pizza"]);
  });

  test("every word must be matched, each as a set of alternatives", () => {
    const t = searchTokens("pizza walmart");
    expect(t).toHaveLength(2);
    expect(t[0]).toEqual(["pizza"]);
    expect(t[1]).toContain("walmart");
    expect(searchTokens("   ")).toEqual([]);
  });
});
