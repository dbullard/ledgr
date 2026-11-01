import { and, eq, isNull, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { accounts } from "@/db/schema";

export function notDeleted(table: { deletedAt: PgColumn }) {
  return isNull(table.deletedAt);
}

export function notHidden(table: { isHidden: PgColumn }) {
  return eq(table.isHidden, false);
}

/**
 * True unless the transaction belongs to a hidden account. Hiding an account is how
 * a user ignores one that duplicates another (the same bank account linked through
 * two logins, say), so its transactions stay out of lists, budgets and reports.
 */
export function notInHiddenAccount(table: { accountId: PgColumn }) {
  return sql`NOT EXISTS (SELECT 1 FROM ${accounts} WHERE ${accounts.id} = ${table.accountId} AND ${accounts.isHidden} = true)`;
}

/** A transaction that is neither hidden itself nor part of a hidden account. */
export function isVisibleTransaction(table: { isHidden: PgColumn; accountId: PgColumn }) {
  return and(notHidden(table), notInHiddenAccount(table));
}

export function sumAbs(col: PgColumn) {
  return sql<number>`COALESCE(SUM(ABS(${col})), 0)`.mapWith(Number);
}

export function sumCol(col: PgColumn) {
  return sql<number>`COALESCE(SUM(${col}), 0)`.mapWith(Number);
}

export function countRows() {
  return sql<number>`count(*)`.mapWith(Number);
}

export function encodeCursor(date: string, id: string): string {
  return Buffer.from(JSON.stringify({ date, id })).toString("base64");
}

export function decodeCursor(cursor: string): { date: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64").toString());
    if (typeof parsed.date === "string" && typeof parsed.id === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
