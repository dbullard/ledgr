import { describe, expect, it } from "vitest";
import { detectSubscriptionCandidates, type SuggestionTxn } from "./recurring-suggestions";

let n = 0;
function monthly(name: string, cents: number[], endDate = "2026-11-01"): SuggestionTxn[] {
  const [y, m, d] = endDate.split("-").map(Number);
  return cents.map((c, i) => {
    const dt = new Date(Date.UTC(y, m - 1 - (cents.length - 1 - i), d));
    return { id: `t${n++}`, name, merchantName: null, date: dt.toISOString().slice(0, 10), normalizedAmount: -c };
  });
}

describe("detectSubscriptionCandidates", () => {
  it("finds a steady monthly charge and a range that covers the drift", () => {
    const [s] = detectSubscriptionCandidates(monthly("VERIZON WIRELESS 123", [12400, 13100, 12800, 13900]), [], "2026-11-07");
    expect(s.frequency).toBe("monthly");
    expect(s.matchName).toBe("verizon wireless");
    expect(s.minAmount).toBeLessThanOrEqual(12400);
    expect(s.maxAmount).toBeGreaterThanOrEqual(13900);
    expect(s.nextDate).toBe("2026-12-01");
  });

  it("skips items already tracked, stopped charges and one-offs", () => {
    const txns = [...monthly("NETFLIX", [1599, 1599, 1599]), ...monthly("OLD GYM", [3000, 3000, 3000], "2026-03-01"), ...monthly("HOME DEPOT", [4000, 9100])];
    expect(detectSubscriptionCandidates(txns, [{ name: "Netflix", matchName: "netflix" }], "2026-11-07")).toEqual([]);
  });

  it("ignores irregular timing", () => {
    const dates = ["2026-01-03", "2026-02-20", "2026-03-02", "2026-06-15"];
    const txns = dates.map((date, i) => ({ id: `r${i}`, name: "RANDOM CAFE", merchantName: null, date, normalizedAmount: -500 }));
    expect(detectSubscriptionCandidates(txns, [], "2026-06-20")).toEqual([]);
  });
});
