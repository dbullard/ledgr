import { describe, test, expect } from "vitest";
import { confidentMatch, suggestMatches, type TxnCandidate } from "../../src/lib/receipts/match";

const t = (id: string, name: string, date: string, amount: number): TxnCandidate => ({
  id,
  name,
  date,
  normalizedAmount: amount,
});

describe("suggestMatches", () => {
  const txns = [
    t("a", "Amazon", "2026-11-02", -7539),
    t("b", "Amazon", "2026-11-02", -6240),
    t("c", "Spotify", "2026-10-04", -2408),
    t("d", "Spotify", "2026-11-04", -2408),
  ];

  test("requires the exact amount and ranks by date and merchant", () => {
    const s = suggestMatches({ totalCents: 7539, date: "2026-11-02", merchant: "Amazon" }, txns);
    expect(s.map((x) => x.txn.id)).toEqual(["a"]);
    expect(s[0].reasons).toEqual(["exact amount", "same day", "merchant name"]);
  });

  test("picks the right month of a repeating subscription and is confident", () => {
    const hints = { totalCents: 2408, date: "2026-11-04", merchant: "Spotify" };
    const s = suggestMatches(hints, txns);
    expect(s[0].txn.id).toBe("d");
    expect(confidentMatch(hints, s)?.txn.id).toBe("d");
  });

  test("not confident when two charges tie, or the date is far, or there is no date", () => {
    const tie = [t("x", "Shop", "2026-11-02", -500), t("y", "Shop", "2026-11-03", -500)];
    const hints = { totalCents: 500, date: "2026-11-02", merchant: null };
    expect(confidentMatch(hints, suggestMatches(hints, tie))).toBeNull();

    const far = { totalCents: 7539, date: "2026-10-20", merchant: null };
    expect(confidentMatch(far, suggestMatches(far, txns))).toBeNull();

    const noDate = { totalCents: 7539, date: null, merchant: "Amazon" };
    expect(confidentMatch(noDate, suggestMatches(noDate, txns))).toBeNull();
  });

  test("never auto-attaches to a different merchant with the same amount", () => {
    const openai = t("o", "Openai", "2026-11-16", -2000);
    const hints = { totalCents: 2000, date: "2026-11-18", merchant: "Anthropic, PBC" };
    const s = suggestMatches(hints, [openai]);
    expect(s[0].txn.id).toBe("o");
    expect(confidentMatch(hints, s)).toBeNull();
  });

  test("still auto-attaches when the merchant matches or the receipt names none", () => {
    const anthropic = t("n", "Anthropic Anthropic* David J Bullard", "2026-11-19", -2000);
    const named = { totalCents: 2000, date: "2026-11-18", merchant: "Anthropic, PBC" };
    expect(confidentMatch(named, suggestMatches(named, [anthropic]))?.txn.id).toBe("n");
    const unnamed = { totalCents: 2000, date: "2026-11-18", merchant: null };
    expect(confidentMatch(unnamed, suggestMatches(unnamed, [anthropic]))?.txn.id).toBe("n");
  });

  test("without an amount, needs merchant and a close date", () => {
    const s = suggestMatches({ totalCents: null, date: "2026-11-02", merchant: "amazon" }, txns);
    expect(s.map((x) => x.txn.id).sort()).toEqual(["a", "b"]);
    expect(suggestMatches({ totalCents: null, date: null, merchant: null }, txns)).toEqual([]);
  });
});
