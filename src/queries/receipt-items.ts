import { asc, eq, gte, lte, sql, desc } from "drizzle-orm";
import { db as defaultDb, type LedgrDb } from "@/db";
import { categories, receiptItems, receipts, transactions } from "@/db/schema";
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

export interface TopProductRow {
  /** Lowercased product name; pass to getProductPriceHistory. */
  key: string;
  name: string;
  totalCents: number;
  purchases: number;
  lastDate: string;
  /** Average price per 1 unit (each, lb...), in cents. */
  avgUnitCents: number;
}

export async function getTopProducts(
  householdId: string,
  filters: ItemFilters,
  limit = 25,
  db: LedgrDb = defaultDb,
): Promise<TopProductRow[]> {
  const total = sql<number>`sum(${receiptItems.totalCents})`.mapWith(Number);
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
    .where(base(householdId, db, filters))
    .groupBy(productKey)
    .orderBy(desc(total))
    .limit(limit);
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    totalCents: r.totalCents,
    purchases: r.purchases,
    lastDate: r.lastDate,
    avgUnitCents: r.qty > 0 ? Math.round((r.totalCents * 1000) / r.qty) : r.totalCents,
  }));
}

export interface PricePoint {
  date: string;
  merchant: string;
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
      merchant: transactions.name,
      totalCents: receiptItems.totalCents,
      quantityMilli: receiptItems.quantityMilli,
    })
    .from(receiptItems)
    .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
    .innerJoin(transactions, eq(receipts.transactionId, transactions.id))
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
    ...r,
    unitCents: r.quantityMilli > 0 ? Math.round((r.totalCents * 1000) / r.quantityMilli) : r.totalCents,
  }));
}
