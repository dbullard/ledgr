import { shiftMonth } from "@/lib/date-utils";

export interface MonthPoint {
  month: string; // YYYY-MM
  amount: number; // cents, absolute spend (refunds net against it)
  projected: boolean;
}

interface Txn {
  date: string;
  normalizedAmount: number;
}

/**
 * Spend per month for a recurring item: the last `months` months up to today,
 * zero-filled, plus the month of its next expected payment, drawn as projected
 * when that month has no payment yet.
 */
export function monthlySeries(
  txns: Txn[],
  today: string,
  opts: { months?: number; next?: { date: string; amount: number } | null } = {},
): MonthPoint[] {
  const months = opts.months ?? 12;
  const current = today.slice(0, 7);
  const nextMonth = opts.next ? opts.next.date.slice(0, 7) : null;
  const last = nextMonth && nextMonth > current ? nextMonth : current;

  const totals = new Map<string, number>();
  for (const t of txns) {
    const m = t.date.slice(0, 7);
    totals.set(m, (totals.get(m) ?? 0) - t.normalizedAmount);
  }

  const points: MonthPoint[] = [];
  for (let m = shiftMonth(current, -(months - 1)); m <= last; m = shiftMonth(m, 1)) {
    const actual = totals.get(m) ?? 0;
    const projected = opts.next != null && m === nextMonth && actual === 0;
    points.push({ month: m, amount: projected ? opts.next!.amount : actual, projected });
  }
  return points;
}

/** Total and average transaction per calendar year, newest first. */
export function yearlyMetrics(txns: Txn[]): { year: number; spent: number; average: number }[] {
  const byYear = new Map<number, { spent: number; count: number }>();
  for (const t of txns) {
    const year = Number(t.date.slice(0, 4));
    const entry = byYear.get(year) ?? { spent: 0, count: 0 };
    entry.spent += -t.normalizedAmount;
    entry.count += 1;
    byYear.set(year, entry);
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => b - a)
    .map(([year, { spent, count }]) => ({ year, spent, average: Math.round(spent / count) }));
}
