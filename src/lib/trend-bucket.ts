import { monthBounds } from "./date-utils";

export type TrendBucketGranularity = "week" | "month" | "year" | "5y";

const SHAPE: Record<TrendBucketGranularity, RegExp> = {
  week: /^\d{4}-\d{2}-\d{2}$/,
  month: /^\d{4}-\d{2}$/,
  year: /^\d{4}$/,
  "5y": /^\d{4}$/,
};

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * The date range a trend-chart bar covers, from the bucket key the trend query
 * produces (YYYY-MM-DD week start, YYYY-MM, YYYY, or the first year of a
 * five-year block). Null for a key that doesn't fit the granularity, so a
 * hand-edited URL falls back to the unfiltered list.
 */
export function trendBucketBounds(
  period: string,
  granularity: TrendBucketGranularity,
): { from: string; to: string } | null {
  if (!SHAPE[granularity].test(period)) return null;
  const monthOk = (m: number) => m >= 1 && m <= 12;
  if (granularity === "month") {
    return monthOk(Number(period.slice(5, 7))) ? monthBounds(period) : null;
  }
  if (granularity === "year") return { from: `${period}-01-01`, to: `${period}-12-31` };
  if (granularity === "5y") return { from: `${period}-01-01`, to: `${Number(period) + 4}-12-31` };
  if (!monthOk(Number(period.slice(5, 7)))) return null;
  return { from: period, to: addDays(period, 6) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Display text for a trend bucket key: short for axis ticks, long for tooltips and the active-filter chip. */
export function trendBucketLabel(period: string, g: TrendBucketGranularity, long: boolean): string {
  if (g === "year") return period;
  if (g === "5y") return `${period}–${Number(period) + 4}`;
  if (g === "month") {
    const [y, m] = period.split("-");
    return long || m === "01" ? `${MONTHS[Number(m) - 1]} ${y}` : MONTHS[Number(m) - 1];
  }
  const [y, m, d] = period.split("-");
  return `${long ? "Week of " : ""}${MONTHS[Number(m) - 1]} ${Number(d)}${long ? `, ${y}` : ""}`;
}
