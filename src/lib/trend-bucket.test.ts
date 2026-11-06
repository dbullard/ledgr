import { describe, it, expect } from "vitest";
import { trendBucketBounds, trendBucketLabel } from "./trend-bucket";

describe("trendBucketBounds", () => {
  it("covers a whole month, including a leap February", () => {
    expect(trendBucketBounds("2026-11", "month")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(trendBucketBounds("2024-02", "month")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
  });

  it("covers seven days from a week start, across a month boundary", () => {
    expect(trendBucketBounds("2026-10-26", "week")).toEqual({ from: "2026-10-26", to: "2026-11-01" });
  });

  it("covers a year and a five-year block", () => {
    expect(trendBucketBounds("2025", "year")).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(trendBucketBounds("2025", "5y")).toEqual({ from: "2025-01-01", to: "2029-12-31" });
  });

  it("rejects keys that don't fit the granularity", () => {
    expect(trendBucketBounds("2026-11", "week")).toBeNull();
    expect(trendBucketBounds("2026-11-01", "month")).toBeNull();
    expect(trendBucketBounds("2026-13", "month")).toBeNull();
    expect(trendBucketBounds("garbage", "year")).toBeNull();
  });
});

describe("trendBucketLabel", () => {
  it("labels each granularity, short for axis ticks and long for the filter chip", () => {
    expect(trendBucketLabel("2026-11", "month", true)).toBe("Nov 2026");
    expect(trendBucketLabel("2026-11", "month", false)).toBe("Nov");
    expect(trendBucketLabel("2026-01", "month", false)).toBe("Jan 2026");
    expect(trendBucketLabel("2026-10-26", "week", true)).toBe("Week of Oct 26, 2026");
    expect(trendBucketLabel("2025", "5y", true)).toBe("2025–2029");
  });
});
