import { classifyAccountType } from "./account-utils";

// Dollars -> whole cents, rounding half away from zero on the *decimal* value.
// `Math.round(x * 100)` is wrong for values like 1.005, whose binary product is
// 100.49999999999999 and so loses a cent. Shifting the decimal point in the
// string form (the "e2" exponent) rounds what the user or provider wrote.
function dollarsToCents(dollars: number): number {
  const abs = Math.abs(dollars);
  const text = String(abs);
  const cents = text.includes("e") ? Math.round(abs * 100) : Math.round(Number(`${text}e2`));
  // No -0: it breaks strict equality downstream.
  return dollars < 0 && cents !== 0 ? -cents : cents;
}

export function centsToDisplay(cents: number, currency = "USD"): string {
  return currencyFormat(currency).format(cents / 100);
}

// Stored currency codes come from upstream providers and are not guaranteed to
// be ISO 4217: SimpleFIN institutions can send "" (#170), and the SimpleFIN
// spec allows a URL for a custom currency. Intl throws a RangeError on either,
// which takes down whatever page is rendering the amount, so fall back to USD.
function currencyFormat(currency: string): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  }
}

/**
 * A signed amount, always carrying its sign: "+$12.50", "-$12.50", "+$0.00".
 *
 * Intl already renders a minus for negatives, but never a plus for positives.
 * Where a figure is a delta rather than a quantity — a net, a gain/loss — the
 * leading "+" is what makes it read as one, so both signs are written here.
 */
export function centsToSignedDisplay(cents: number, currency = "USD"): string {
  const display = centsToDisplay(Math.abs(cents), currency);
  return cents < 0 ? `-${display}` : `+${display}`;
}

export function displayToCents(display: number): number {
  return dollarsToCents(display);
}

// Whole-dollar display with thousands separators and no cents: "$4,874",
// "-$212". For a headline figure where two decimals of cents are noise —
// a chart bar's value label, a Change column's dollar delta — but the
// abbreviated "$4.9K" of centsToCompact loses too much precision to compare
// two nearby categories.
export function centsToWholeDisplay(cents: number): string {
  const dollars = Math.round(Math.abs(cents) / 100);
  // Under 50 cents rounds to zero; "-$0" would read as a negative amount.
  const sign = cents < 0 && dollars > 0 ? "-" : "";
  return `${sign}$${dollars.toLocaleString("en-US")}`;
}

// Compact axis-label form: $128.3K, $1.2M, $840. Sign is preserved.
export function centsToCompact(cents: number): string {
  const dollars = cents / 100;
  const abs = Math.abs(dollars);
  const sign = dollars < 0 ? "-" : "";
  // Thresholds sit at the rounding edge, not the unit: 999,950 rounds to one
  // decimal as "1000.0K", which should read "$1M".
  if (abs >= 999_950) return `${sign}$${trimZero((abs / 1_000_000).toFixed(1))}M`;
  if (abs >= 999.5) return `${sign}$${trimZero((abs / 1_000).toFixed(1))}K`;
  const whole = Math.round(abs);
  return `${whole === 0 ? "" : sign}$${whole}`;
}

/**
 * Axis tick formatter chosen from how wide the plotted values actually are.
 *
 * `centsToCompact` rounds to one decimal of a thousand — $100 of resolution —
 * so a chart whose values span less than that renders every tick with the same
 * text. That happens whenever the visible window is short: a household whose
 * balance history starts a couple of days ago got four ticks all reading
 * "$52.9K".
 */
export function axisTickFormatter(valuesInCents: number[]): (cents: number) => string {
  if (valuesInCents.length === 0) return centsToCompact;

  const spread = Math.max(...valuesInCents) - Math.min(...valuesInCents);
  if (spread >= 10_000) return centsToCompact;

  // Narrow domain: whole dollars with separators, distinguishable without the
  // noise of cents on an axis.
  return (cents: number) =>
    `${cents < 0 ? "-" : ""}$${Math.round(Math.abs(cents) / 100).toLocaleString("en-US")}`;
}

function trimZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

// Plaid convention: positive = money out, negative = money in, for every
// account type alike. We flip universally so: negative = expense, positive =
// income. Deliberately takes no account type -- normalization does not depend
// on one, and a parameter implying otherwise is misleading.
export function normalizeAmount(amountCents: number): number {
  return amountCents === 0 ? 0 : -amountCents;
}

export function plaidAmountToCents(plaidAmount: number | null | undefined): number | null {
  if (plaidAmount === null || plaidAmount === undefined) return null;
  return dollarsToCents(plaidAmount);
}

// Account *balance* normalization — distinct from plaidAmountToCents, which is
// also used for transaction amounts and must not flip anything.
//
// Plaid docs, `balances.current`: "For credit and loan accounts, a positive
// balance indicates amount owed; negative indicates lender owes account
// holder." Ledgr stores owed as negative for every account type (see the
// currentBalance note in db/schema/accounts.ts), so liabilities get flipped.
export function plaidBalanceToCents(
  plaidAmount: number | null | undefined,
  accountType: string
): number | null {
  const cents = plaidAmountToCents(plaidAmount);
  if (cents === null) return null;
  if (classifyAccountType(accountType) !== "liability") return cents;
  // Guard the JS -0 gotcha: -0 breaks strict equality checks downstream.
  return cents === 0 ? 0 : -cents;
}

// SimpleFIN amounts are decimal strings, e.g. "-33293.43". Unlike Plaid's
// convention (positive = money out), SimpleFIN's positive = deposit/income
// already matches our normalizedAmount invariant — no sign flip needed at
// the call site.
export function simplefinAmountToCents(amountStr: string): number | null {
  if (amountStr.trim() === "") return null;
  const n = Number(amountStr);
  if (Number.isNaN(n)) return null;
  return dollarsToCents(n);
}

export function centsToInputDisplay(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function parseToCents(input: string): number | null {
  let s = input.trim();
  if (s === "") return null;
  let sign = 1;
  // Accounting negatives: (123.45)
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1).trim();
  }
  // Leading/trailing explicit sign
  if (s.startsWith("-")) {
    sign *= -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  s = s.replace(/[^0-9.,]/g, ""); // drop currency symbols/spaces
  if (s === "") return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  // With both present, the rightmost of . or , is the decimal separator and the
  // other is grouping. A lone separator kind is ambiguous, so: repeated commas
  // or dots are grouping, and a single comma followed by exactly three digits
  // is US grouping ("1,234" is $1,234, not $1.23). Any other single comma is a
  // decimal ("1234,56", "12,5").
  const commas = (s.match(/,/g) ?? []).length;
  const dots = (s.match(/\./g) ?? []).length;
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized =
      lastComma > lastDot
        ? s.replace(/\./g, "").replace(",", ".")
        : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    const groupingOnly = commas > 1 || s.length - lastComma - 1 === 3;
    normalized = groupingOnly ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (dots > 1) {
    normalized = s.replace(/\./g, ""); // "1.234.567" is grouping
  } else {
    normalized = s;
  }
  const parsed = Number(normalized);
  if (Number.isNaN(parsed)) return null;
  const cents = dollarsToCents(parsed);
  return cents === 0 ? 0 : sign * cents;
}
