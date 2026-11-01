export type Frequency = "weekly" | "biweekly" | "semimonthly" | "monthly" | "yearly";

export interface MatchRules {
  matchName: string | null;
  matchMinAmount: number | null;
  matchMaxAmount: number | null;
  matchDayOfMonth: number | null;
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year: number, month: number, day: number): string {
  // month may overflow past 12; Date.UTC normalises it.
  const clamped = Math.min(day, daysInMonth(year + Math.floor((month - 1) / 12), ((month - 1) % 12) + 1));
  return new Date(Date.UTC(year, month - 1, clamped)).toISOString().slice(0, 10);
}

/**
 * Whether a transaction belongs to a recurring item. A rule left null means
 * "any", except the name: with no name there is nothing to anchor on, so an
 * item without one matches nothing rather than everything.
 */
export function matchesRules(
  txn: { name: string; date: string; normalizedAmount: number },
  rules: MatchRules,
): boolean {
  const needle = rules.matchName?.trim().toLowerCase();
  if (!needle) return false;
  if (!txn.name.toLowerCase().includes(needle)) return false;

  const amount = Math.abs(txn.normalizedAmount);
  if (rules.matchMinAmount !== null && amount < rules.matchMinAmount) return false;
  if (rules.matchMaxAmount !== null && amount > rules.matchMaxAmount) return false;

  if (rules.matchDayOfMonth !== null) {
    const [y, m, d] = parts(txn.date);
    if (d !== Math.min(rules.matchDayOfMonth, daysInMonth(y, m))) return false;
  }
  return true;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The date a payment is next expected after `date`. UTC maths only. */
export function nextDateAfter(date: string, frequency: Frequency): string {
  const [y, m, d] = parts(date);
  switch (frequency) {
    case "weekly":
      return addDays(date, 7);
    case "biweekly":
      return addDays(date, 14);
    case "monthly":
      return iso(y, m + 1, d);
    case "yearly":
      return iso(y + 1, m, d);
    case "semimonthly":
      // Two payments a month: the 1st-ish half and the 16th-ish half.
      return d < 15 ? addDays(date, 15) : iso(y, m + 1, Math.max(d - 15, 1));
  }
}
