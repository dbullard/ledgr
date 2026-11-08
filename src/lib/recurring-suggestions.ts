import { nextDateAfter, type Frequency } from "@/lib/recurring-match";

export interface SuggestionTxn {
  id: string;
  name: string;
  merchantName: string | null;
  date: string;
  /** Expenses are negative. */
  normalizedAmount: number;
}

export interface ExistingItem {
  name: string;
  matchName: string | null;
}

export interface SubscriptionSuggestion {
  key: string;
  name: string;
  matchName: string;
  averageAmount: number;
  minAmount: number;
  maxAmount: number;
  frequency: Frequency;
  lastDate: string;
  nextDate: string;
  count: number;
  /** Rough 0..1 confidence from how regular the timing and amount are. */
  confidence: number;
  transactionIds: string[];
}

const DAY = 86_400_000;
const MONTHLY_MULTIPLIER: Record<string, number> = { weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, yearly: 1 / 12 };

function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Lowercase, drop store numbers, dates and punctuation so "NETFLIX 1234" and "Netflix #88" group together. */
export function normalizeMerchant(s: string): string {
  return s
    .toLowerCase()
    .replace(/\d+/g, " ")
    .replace(/[^a-z& ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function frequencyFor(interval: number): { frequency: Frequency; period: number; tolerance: number } | null {
  if (interval >= 6 && interval <= 8) return { frequency: "weekly", period: 7, tolerance: 2 };
  if (interval >= 13 && interval <= 15) return { frequency: "biweekly", period: 14, tolerance: 3 };
  if (interval >= 27 && interval <= 34) return { frequency: "monthly", period: 30.4, tolerance: 5 };
  if (interval >= 355 && interval <= 375) return { frequency: "yearly", period: 365, tolerance: 14 };
  return null;
}

/** The longest text every name shares, preferred as the match rule since it is guaranteed to hit them all. */
function sharedMatchName(txns: SuggestionTxn[]): string {
  const names = txns.map((t) => t.name.toLowerCase());
  let prefix = names[0];
  for (const n of names) {
    while (prefix && !n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  prefix = prefix.replace(/[\s#*\-_.\d]+$/, "").trim();
  if (prefix.length >= 3) return prefix;
  const merchant = txns.find((t) => t.merchantName)?.merchantName?.toLowerCase();
  if (merchant && names.every((n) => n.includes(merchant))) return merchant;
  return names[0].split(/\s+/)[0] ?? names[0];
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Finds charges that repeat on a steady schedule but aren't tracked yet. Needs
 * at least three payments, timing that clusters around a known period, amounts
 * that stay in a band, and a recent payment (so cancelled services drop out).
 */
export function detectSubscriptionCandidates(
  txns: SuggestionTxn[],
  existing: ExistingItem[],
  today: string,
): SubscriptionSuggestion[] {
  const groups = new Map<string, SuggestionTxn[]>();
  for (const t of txns) {
    if (t.normalizedAmount >= 0) continue;
    const key = normalizeMerchant(t.merchantName || t.name);
    if (key.length < 2) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
  }

  const tracked = existing
    .flatMap((e) => [e.name, e.matchName ?? ""])
    .map(normalizeMerchant)
    .filter((s) => s.length >= 2);

  const todayN = dayNumber(today);
  const out: SubscriptionSuggestion[] = [];

  for (const [key, group] of groups) {
    if (group.length < 3) continue;
    if (tracked.some((t) => t === key || key.includes(t) || t.includes(key))) continue;

    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
    const days = sorted.map((t) => dayNumber(t.date));
    const gaps = days.slice(1).map((d, i) => d - days[i]).filter((g) => g > 0);
    if (gaps.length < 2) continue;

    const spec = frequencyFor(median(gaps));
    if (!spec) continue;
    const onSchedule = gaps.filter((g) => Math.abs(g - spec.period) <= spec.tolerance).length / gaps.length;
    if (onSchedule < 0.7) continue;

    const amounts = sorted.map((t) => Math.abs(t.normalizedAmount));
    const mid = median(amounts);
    const inBand = amounts.filter((a) => Math.abs(a - mid) <= mid * 0.35);
    if (inBand.length / amounts.length < 0.6) continue;

    const lastN = days[days.length - 1];
    if (todayN - lastN > spec.period * 2.2) continue;

    const matchName = sharedMatchName(sorted);
    const lastDate = sorted[sorted.length - 1].date;
    const confidence = Math.min(1, onSchedule * 0.6 + (inBand.length / amounts.length) * 0.3 + Math.min(sorted.length, 6) / 60);

    out.push({
      key,
      name: mostCommon(sorted.map((t) => t.merchantName || t.name)),
      matchName,
      averageAmount: Math.round(mid),
      minAmount: Math.floor(Math.min(...inBand) * 0.95),
      maxAmount: Math.ceil(Math.max(...inBand) * 1.05),
      frequency: spec.frequency,
      lastDate,
      nextDate: nextDateAfter(lastDate, spec.frequency),
      count: sorted.length,
      confidence,
      transactionIds: sorted.slice(-12).map((t) => t.id),
    });
  }

  return out
    .sort((a, b) => b.averageAmount * MONTHLY_MULTIPLIER[b.frequency] - a.averageAmount * MONTHLY_MULTIPLIER[a.frequency])
    .slice(0, 20);
}
