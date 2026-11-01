import { describe, it, expect } from "vitest";
import { test as fcTest, fc } from "@fast-check/vitest";
import { matchesRules, nextDateAfter, type MatchRules } from "./recurring-match";

const none: MatchRules = { matchName: null, matchMinAmount: null, matchMaxAmount: null, matchDayOfMonth: null };
const txn = (over: Partial<{ name: string; date: string; normalizedAmount: number }> = {}) => ({
  name: "AT&T Bill Payment",
  date: "2026-10-19",
  normalizedAmount: -9220,
  ...over,
});

describe("matchesRules", () => {
  it("empty matchName matches nothing", () => {
    expect(matchesRules(txn(), none)).toBe(false);
    expect(matchesRules(txn(), { ...none, matchName: "   " })).toBe(false);
  });

  it("matches name case-insensitively as a substring", () => {
    expect(matchesRules(txn(), { ...none, matchName: "at&t bill" })).toBe(true);
    expect(matchesRules(txn(), { ...none, matchName: "verizon" })).toBe(false);
  });

  it("amount bounds are inclusive and use absolute value", () => {
    const rules = { ...none, matchName: "at&t", matchMinAmount: 4500, matchMaxAmount: 9400 };
    expect(matchesRules(txn({ normalizedAmount: -4500 }), rules)).toBe(true);
    expect(matchesRules(txn({ normalizedAmount: -9400 }), rules)).toBe(true);
    expect(matchesRules(txn({ normalizedAmount: -9401 }), rules)).toBe(false);
    expect(matchesRules(txn({ normalizedAmount: -4499 }), rules)).toBe(false);
  });

  it("day 31 matches the last day of shorter months", () => {
    const rules = { ...none, matchName: "at&t", matchDayOfMonth: 31 };
    expect(matchesRules(txn({ date: "2026-02-28" }), rules)).toBe(true);
    expect(matchesRules(txn({ date: "2026-04-30" }), rules)).toBe(true);
    expect(matchesRules(txn({ date: "2026-04-29" }), rules)).toBe(false);
    expect(matchesRules(txn({ date: "2026-01-31" }), rules)).toBe(true);
  });

  it("a specific day only matches that day", () => {
    const rules = { ...none, matchName: "at&t", matchDayOfMonth: 19 };
    expect(matchesRules(txn({ date: "2026-10-19" }), rules)).toBe(true);
    expect(matchesRules(txn({ date: "2026-10-20" }), rules)).toBe(false);
  });
});

describe("nextDateAfter", () => {
  it("weekly and biweekly add days", () => {
    expect(nextDateAfter("2026-10-30", "weekly")).toBe("2026-11-06");
    expect(nextDateAfter("2026-10-30", "biweekly")).toBe("2026-11-13");
  });
  it("monthly clamps to the end of a shorter month", () => {
    expect(nextDateAfter("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(nextDateAfter("2026-12-15", "monthly")).toBe("2027-01-15");
  });
  it("yearly maps Feb 29 to Feb 28", () => {
    expect(nextDateAfter("2028-02-29", "yearly")).toBe("2029-02-28");
  });
  it("semimonthly alternates halves of the month", () => {
    expect(nextDateAfter("2026-10-01", "semimonthly")).toBe("2026-10-16");
    expect(nextDateAfter("2026-10-16", "semimonthly")).toBe("2026-11-01");
  });

  fcTest.prop([
    fc.date({ min: new Date("2000-01-01"), max: new Date("2090-12-31"), noInvalidDate: true }),
    fc.constantFrom("weekly", "biweekly", "semimonthly", "monthly", "yearly" as const),
  ])("is always strictly after the input date", (d, frequency) => {
    const date = d.toISOString().slice(0, 10);
    expect(nextDateAfter(date, frequency) > date).toBe(true);
  });
});
