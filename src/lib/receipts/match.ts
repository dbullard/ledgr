import type { ReceiptHints } from "./hints";

export interface TxnCandidate {
  id: string;
  name: string;
  date: string;
  /** Cents; sign is ignored. */
  normalizedAmount: number;
}

export interface Suggestion {
  txn: TxnCandidate;
  score: number;
  reasons: string[];
}

function dayDiff(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function merchantOverlap(hint: string | null, name: string): boolean {
  if (!hint) return false;
  const a = tokens(hint);
  const b = tokens(name);
  return a.some((x) => b.some((y) => x === y || x.startsWith(y) || y.startsWith(x)));
}

export function scoreCandidate(hints: ReceiptHints, txn: TxnCandidate): Suggestion {
  let score = 0;
  const reasons: string[] = [];

  const amountMatch =
    hints.totalCents !== null && Math.abs(txn.normalizedAmount) === hints.totalCents;
  if (amountMatch) {
    score += 60;
    reasons.push("exact amount");
  }

  if (hints.date) {
    const d = dayDiff(hints.date, txn.date);
    const pts = d <= 1 ? 25 : d <= 3 ? 20 : d <= 5 ? 12 : d <= 10 ? 5 : 0;
    if (pts > 0) {
      score += pts;
      reasons.push(d === 0 ? "same day" : `${Math.round(d)} day${d >= 1.5 ? "s" : ""} apart`);
    }
  }

  if (merchantOverlap(hints.merchant, txn.name)) {
    score += 15;
    reasons.push("merchant name");
  }

  return { txn, score, reasons };
}

/** Ranked suggestions, best first. Needs an exact amount, or (with no amount) a merchant and a close date. */
export function suggestMatches(
  hints: ReceiptHints,
  candidates: TxnCandidate[],
  limit = 3,
): Suggestion[] {
  return candidates
    .map((c) => scoreCandidate(hints, c))
    .filter((s) =>
      hints.totalCents !== null
        ? s.reasons.includes("exact amount")
        : s.reasons.includes("merchant name") && s.score >= 30,
    )
    .sort((a, b) => b.score - a.score || (a.txn.date < b.txn.date ? 1 : -1))
    .slice(0, limit);
}

/**
 * Safe to attach without asking: exact amount, a date within 3 days, and no
 * close runner-up (a monthly subscription repeats the same amount).
 */
export function confidentMatch(hints: ReceiptHints, suggestions: Suggestion[]): Suggestion | null {
  const [top, second] = suggestions;
  if (!top || hints.totalCents === null || !hints.date) return null;
  if (!top.reasons.includes("exact amount")) return null;
  if (dayDiff(hints.date, top.txn.date) > 3) return null;
  if (second && top.score - second.score < 20) return null;
  return top;
}
