import { withHousehold } from "@/lib/household-context";
import { accountDisplayName } from "@/lib/account-name";
import { getTransactions } from "@/queries/transactions";
import { getAccounts } from "@/queries/accounts";
import { getCategories } from "@/queries/categories";
import { getCategoryRules } from "@/queries/category-rules";
import { getRecurrings } from "@/queries/recurring";
import { getHoldings, getInvestmentAccountIds } from "@/queries/investments";
import { getTopProducts } from "@/queries/receipt-items";

/**
 * Backs the Mac and iPhone apps' search. Wider than the web command palette:
 * it covers every list a person might look something up in, and returns each
 * hit as a small row the app can show and route on. Transactions come back in
 * the full shape the Transactions list uses, so the app can open the detail
 * screen directly.
 */

export const MIN_QUERY_LENGTH = 2;
const MAX_TRANSACTIONS = 8;
const MAX_PER_KIND = 5;

export type SearchKind =
  | "account"
  | "category"
  | "rule"
  | "recurring"
  | "item"
  | "holding";

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string | null;
  /** Cents, when the hit has one worth showing next to it. */
  amount: number | null;
}

/** Case-insensitive "contains" across any of the given fields. */
export function matches(needle: string, ...fields: (string | null | undefined)[]): boolean {
  const n = needle.toLowerCase();
  return fields.some((f) => !!f && f.toLowerCase().includes(n));
}

export async function nativeSearch(householdId: string, rawQuery: string) {
  const query = rawQuery.trim().slice(0, 120);
  if (query.length < MIN_QUERY_LENGTH) return { transactions: [], hits: [] as SearchHit[] };

  const today = new Date().toISOString().slice(0, 10);

  const [txnPage, accounts, groups, rules, recurring, accIds, products] = await Promise.all([
    withHousehold(householdId, (tx) =>
      getTransactions(householdId, { search: query }, MAX_TRANSACTIONS, undefined, tx),
    ),
    getAccounts(householdId),
    withHousehold(householdId, (tx) => getCategories(householdId, tx)),
    withHousehold(householdId, (tx) => getCategoryRules(householdId, tx)),
    getRecurrings(householdId, { search: query }),
    getInvestmentAccountIds(householdId),
    withHousehold(householdId, (tx) =>
      getTopProducts(householdId, { dateFrom: "2000-01-01", dateTo: today, categoryId: null }, MAX_PER_KIND, tx, {
        search: query,
      }),
    ),
  ]);

  const holdings = await getHoldings(householdId, "consolidated", undefined, undefined, accIds);

  const hits: SearchHit[] = [];
  const push = (list: SearchHit[]) => hits.push(...list.slice(0, MAX_PER_KIND));

  push(
    accounts
      .filter((a) => !a.isHidden && matches(query, accountDisplayName(a.name), a.officialName))
      .map((a) => ({
        kind: "account" as const,
        id: a.id,
        title: accountDisplayName(a.name),
        subtitle: a.type,
        amount: a.currentBalance ?? null,
      })),
  );

  push(
    groups.flatMap((g) =>
      g.categories
        .filter((c) => matches(query, c.name))
        .map((c) => ({ kind: "category" as const, id: c.id, title: c.name, subtitle: g.name, amount: null })),
    ),
  );

  push(
    rules
      .filter((r) => matches(query, r.matchPattern, r.categoryName))
      .map((r) => ({
        kind: "rule" as const,
        id: r.id,
        title: r.matchPattern,
        subtitle: `${r.matchField === "merchant" ? "Merchant" : "Name"} → ${r.categoryName}`,
        amount: null,
      })),
  );

  push(
    [...recurring.overdue, ...recurring.thisMonth, ...recurring.future, ...recurring.paused, ...recurring.archived].map(
      (r) => ({
        kind: "recurring" as const,
        id: r.id,
        title: r.name,
        subtitle: r.frequency,
        amount: r.lastAmount ?? r.averageAmount ?? null,
      }),
    ),
  );

  push(
    products.map((p) => ({
      kind: "item" as const,
      id: p.key,
      title: p.name,
      subtitle: `${p.purchases} purchase${p.purchases === 1 ? "" : "s"}`,
      amount: p.totalCents,
    })),
  );

  push(
    holdings
      .filter((h) => matches(query, h.ticker, h.securityName))
      .map((h) => ({
        kind: "holding" as const,
        id: h.ticker ?? h.securityName ?? "",
        title: h.securityName ?? h.ticker ?? "",
        subtitle: h.ticker,
        amount: h.currentValue,
      })),
  );

  return { transactions: txnPage.rows, hits };
}
