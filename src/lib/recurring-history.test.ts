import { describe, it, expect } from "vitest";
import { monthlySeries, yearlyMetrics } from "./recurring-history";

const t = (date: string, cents: number) => ({ date, normalizedAmount: -cents });

describe("monthlySeries", () => {
  it("sums each month, zero-fills gaps and projects the upcoming payment", () => {
    const series = monthlySeries(
      [t("2026-09-19", 9000), t("2026-10-19", 9220), t("2026-10-20", 100)],
      "2026-11-01",
      { months: 3, next: { date: "2026-11-19", amount: 9220 } },
    );
    expect(series).toEqual([
      { month: "2026-09", amount: 9000, projected: false },
      { month: "2026-10", amount: 9320, projected: false },
      { month: "2026-11", amount: 9220, projected: true },
    ]);
  });

  it("extends the window to a next payment that falls in a later month", () => {
    const series = monthlySeries([t("2026-10-30", 4000)], "2026-11-01", {
      months: 2,
      next: { date: "2026-12-02", amount: 4000 },
    });
    expect(series.map((p) => p.month)).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(series[2]).toEqual({ month: "2026-12", amount: 4000, projected: true });
  });

  it("does not project a month that already has a payment", () => {
    const series = monthlySeries([t("2026-11-05", 500)], "2026-11-10", {
      months: 1,
      next: { date: "2026-11-25", amount: 500 },
    });
    expect(series.find((p) => p.month === "2026-11")).toEqual({ month: "2026-11", amount: 500, projected: false });
  });

  it("has no projection without an upcoming date", () => {
    const series = monthlySeries([], "2026-11-01", { months: 2, next: null });
    expect(series.every((p) => !p.projected && p.amount === 0)).toBe(true);
  });

  it("counts a refund (positive amount) against the month", () => {
    const series = monthlySeries([t("2026-10-01", 1000), { date: "2026-10-02", normalizedAmount: 400 }], "2026-10-15", { months: 1, next: null });
    expect(series.find((p) => p.month === "2026-10")?.amount).toBe(600);
  });
});

describe("yearlyMetrics", () => {
  it("totals and averages per year, newest first", () => {
    expect(
      yearlyMetrics([t("2026-01-01", 1000), t("2026-02-01", 2000), t("2025-05-05", 500)]),
    ).toEqual([
      { year: 2026, spent: 3000, average: 1500 },
      { year: 2025, spent: 500, average: 500 },
    ]);
  });
  it("is empty with no transactions", () => {
    expect(yearlyMetrics([])).toEqual([]);
  });
});
