import { and, asc, eq, gte, inArray, lte, sql, desc } from "drizzle-orm";
import { db as defaultDb, type LedgrDb } from "@/db";
import { accounts, categories, merchants, receiptItems, receipts, transactions } from "@/db/schema";
import { searchTokens, storeLabel } from "@/lib/receipts/store-name";
import { scopedQuery } from "@/lib/scoped-query";
import { isVisibleTransaction, notDeleted } from "@/lib/query-helpers";

/**
 * Item reports count only items on receipts attached to a visible transaction,
 * dated by that transaction. Item totals are pre-tax line prices, so they will
 * not add up to the transactions they came from.
 */
export interface ItemFilters {
  dateFrom: string;
  dateTo: string;
  categoryId?: string | null;
}

const productKey = sql<string>`lower(coalesce(${receiptItems.productName}, ${receiptItems.rawName}))`;
const productLabel = sql<string>`min(coalesce(${receiptItems.productName}, ${receiptItems.rawName}))`;

function base(householdId: string, db: LedgrDb, f: ItemFilters) {
  const scoped = scopedQuery(householdId, db);
  return scoped.where(
    receiptItems,
    notDeleted(transactions),
    isVisibleTransaction(transactions),
    gte(transactions.date, f.dateFrom),
    lte(transactions.date, f.dateTo),
    f.categoryId ? eq(receiptItems.categoryId, f.categoryId) : undefined,
  );
}

export interface ItemCategoryRow {
  categoryId: string | null;
  categoryName: string | null;
  totalCents: number;
  itemCount: number;
}

export async function getItemSpendByCategory(
  householdId: string,
  filters: ItemFilters,
  db: LedgrDb = defaultDb,
): Promise<ItemCategoryRow[]> {
  const total = sql<number>`sum(${receiptItems.totalCents})`.mapWith(Number);
  return db
    .select({
      categoryId: receiptItems.categoryId,
      categoryName: categories.name,
      totalCents: total,
      itemCount: sql<number>`count(*)`.mapWith(Number),
    })
    .from(receiptItems)
    .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
    .innerJoin(transactions, eq(receipts.transactionId, transactions.id))
    .leftJoin(categories, eq(receiptItems.categoryId, categories.id))
    .where(base(householdId, db, filters))
    .groupBy(receiptItems.categoryId, categories.name)
    .orderBy(desc(total));
}

/**
 * Everything a person might type to find an item, as one normalized string:
 * product and printed names, category, store, account, date (ISO and spelled
 * out) and price. Punctuation is dropped so "sam's" finds "Sams Club".
 */
const searchBlob = sql<string>`lower(regexp_replace(concat_ws(' ',
  ${receiptItems.productName}, ${receiptItems.rawName}, ${categories.name},
  ${merchants.name}, ${transactions.name}, ${accounts.name},
  ${transactions.date}, to_char(${transactions.date}::date, 'FMMonth FMDD YYYY'),
  to_char(${receiptItems.totalCents} / 100.0, 'FM999999990.00')
), '[^a-zA-Z0-9. ]', '', 'g'))`;

function searchCondition(search: string | null | undefined) {
  const tokens = searchTokens(search);
  if (tokens.length === 0) return search?.trim() ? sql`false` : undefined; // only punctuation matches nothing
  const escape = (t: string) => t.replace(/[\\%_]/g, "\\$&");
  return and(
    ...tokens.map((alts) =>
      sql`(${sql.join(
        alts.map((a) => sql`${searchBlob} like ${"%" + escape(a) + "%"}`),
        sql` or `,
      )})`,
    ),
  );
}

export interface ProductStore {
  name: string;
  count: number;
}

export interface TopProductRow {
  /** Lowercased product name; pass to getProductPriceHistory. */
  key: string;
  name: string;
  totalCents: number;
  purchases: number;
  lastDate: string;
  /** Average price per 1 unit (each, lb...), in cents. */
  avgUnitCents: number;
  /** Where it was bought, most often first (at most 3). */
  stores: ProductStore[];
  storeCount: number;
}

export type ProductSort = "spent" | "times" | "avg" | "last" | "name";
export const PRODUCT_SORTS: readonly ProductSort[] = ["spent", "times", "avg", "last", "name"];

export interface ProductOptions {
  sort?: ProductSort;
  /** Defaults to descending, except name which defaults to ascending. */
  dir?: "asc" | "desc";
  /**
   * Words are ANDed; each must appear somewhere in the item's name, receipt text,
   * category, store, account, date or price. Totals then cover matching purchases only.
   */
  search?: string | null;
}

export async function getTopProducts(
  householdId: string,
  filters: ItemFilters,
  limit = 25,
  db: LedgrDb = defaultDb,
  opts: ProductOptions = {},
): Promise<TopProductRow[]> {
  const total = sql<number>`sum(${receiptItems.totalCents})`.mapWith(Number);
  const sort = opts.sort ?? "spent";
  const dir = opts.dir ?? (sort === "name" ? "asc" : "desc");
  const sortExpr =
    sort === "times"
      ? sql`count(*)`
      : sort === "avg"
        ? sql`sum(${receiptItems.totalCents})::float / nullif(sum(${receiptItems.quantityMilli}), 0)`
        : sort === "last"
          ? sql`max(${transactions.date})`
          : sort === "name"
            ? productKey
            : total;
  const dirFn = dir === "asc" ? asc : desc;
  const where = and(base(householdId, db, filters), searchCondition(opts.search));
  const rows = await db
    .select({
      key: productKey,
      name: productLabel,
      totalCents: total,
      purchases: sql<number>`count(*)`.mapWith(Number),
      qty: sql<number>`sum(${receiptItems.quantityMilli})`.mapWith(Number),
      lastDate: sql<string>`max(${transactions.date})`,
    })
    .from(receiptItems)
    .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
    .innerJoin(transactions, eq(receipts.transactionId, transactions.id))
    .leftJoin(categories, eq(receiptItems.categoryId, categories.id))
    .leftJoin(merchants, eq(transactions.merchantId, merchants.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(where)
    .groupBy(productKey)
    .orderBy(dirFn(sortExpr), desc(total))
    .limit(limit);

  const byProduct = new Map<string, Map<string, number>>();
  if (rows.length > 0) {
    const stores = await db
      .select({
        key: productKey,
        txnName: transactions.name,
        merchant: merchants.name,
        n: sql<number>`count(*)`.mapWith(Number),
      })
      .from(receiptItems)
      .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
      .innerJoin(transactions, eq(receipts.transactionId, transactions.id))
      .leftJoin(categories, eq(receiptItems.categoryId, categories.id))
      .leftJoin(merchants, eq(transactions.merchantId, merchants.id))
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(where, inArray(productKey, rows.map((r) => r.key))))
      .groupBy(productKey, transactions.name, merchants.name);
    for (const r of stores) {
      const label = storeLabel(r.txnName, r.merchant);
      const m = byProduct.get(r.key) ?? new Map<string, number>();
      m.set(label, (m.get(label) ?? 0) + r.n);
      byProduct.set(r.key, m);
    }
  }
  return rows.map((r) => {
    const all = [...(byProduct.get(r.key) ?? new Map<string, number>())]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return {
      key: r.key,
      name: r.name,
      totalCents: r.totalCents,
      purchases: r.purchases,
      lastDate: r.lastDate,
      avgUnitCents: r.qty > 0 ? Math.round((r.totalCents * 1000) / r.qty) : r.totalCents,
      stores: all.slice(0, 3),
      storeCount: all.length,
    };
  });
}

export interface PricePoint {
  date: string;
  /** Where it was bought, cleaned up for display. */
  merchant: string;
  /** The charge this purchase came from. */
  transactionId: string;
  accountName: string | null;
  unitCents: number;
  totalCents: number;
  quantityMilli: number;
}

/** Every purchase of one product, oldest first, with its per-unit price. */
export async function getProductPriceHistory(
  householdId: string,
  key: string,
  db: LedgrDb = defaultDb,
): Promise<PricePoint[]> {
  const scoped = scopedQuery(householdId, db);
  const rows = await db
    .select({
      date: transactions.date,
      txnName: transactions.name,
      merchantName: merchants.name,
      transactionId: transactions.id,
      accountName: accounts.name,
      totalCents: receiptItems.totalCents,
      quantityMilli: receiptItems.quantityMilli,
    })
    .from(receiptItems)
    .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
    .innerJoin(transactions, eq(receipts.transactionId, transactions.id))
    .leftJoin(merchants, eq(transactions.merchantId, merchants.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(
      scoped.where(
        receiptItems,
        notDeleted(transactions),
        isVisibleTransaction(transactions),
        sql`${productKey} = ${key.toLowerCase()}`,
      ),
    )
    .orderBy(asc(transactions.date))
    .limit(500);
  return rows.map((r) => ({
    date: r.date,
    merchant: storeLabel(r.txnName, r.merchantName),
    transactionId: r.transactionId,
    accountName: r.accountName,
    totalCents: r.totalCents,
    quantityMilli: r.quantityMilli,
    unitCents: r.quantityMilli > 0 ? Math.round((r.totalCents * 1000) / r.quantityMilli) : r.totalCents,
  }));
}
