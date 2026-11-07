import { createHash } from "node:crypto";
import { eq, and, inArray } from "drizzle-orm";
import { matchNearDuplicates } from "./near-match";
import { normalizeAmount } from "@/lib/money";
import { db as defaultDb, type LedgrDb } from "@/db";
import { transactions } from "@/db/schema";
import type { NormalizedRow } from "./normalize";

export function generateDedupHash(row: { date: string; amount: number; description: string }): string {
  const input = `${row.date}|${row.amount}|${row.description.toLowerCase().trim()}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export interface DedupResult {
  unique: NormalizedRow[];
  duplicates: NormalizedRow[];
}

export async function findDuplicates(
  rows: NormalizedRow[],
  accountId: string,
  db: LedgrDb = defaultDb,
): Promise<DedupResult> {
  if (rows.length === 0) return { unique: [], duplicates: [] };

  const withExternalId = rows.filter((r) => r.externalId);
  const withoutExternalId = rows.filter((r) => !r.externalId);

  const duplicates: NormalizedRow[] = [];
  const unique: NormalizedRow[] = [];

  if (withExternalId.length > 0) {
    const existingExternal = await db
      .select({ externalId: transactions.externalId })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, accountId),
          inArray(transactions.externalId, withExternalId.map((r) => r.externalId!)),
        ),
      );
    const existingIds = new Set(existingExternal.map((e) => e.externalId));

    for (const row of withExternalId) {
      if (existingIds.has(row.externalId)) {
        duplicates.push(row);
      } else {
        unique.push(row);
      }
    }
  }

  if (withoutExternalId.length > 0) {
    const existing = await db
      .select({
        date: transactions.date,
        amount: transactions.amount,
        originalName: transactions.originalName,
      })
      .from(transactions)
      .where(eq(transactions.accountId, accountId));

    const existingHashes = new Set(
      existing.map((t) => generateDedupHash({
        date: t.date,
        amount: t.amount,
        description: t.originalName,
      })),
    );

    for (const row of withoutExternalId) {
      const hash = generateDedupHash({
        date: row.date,
        amount: row.amount,
        description: row.originalName,
      });
      if (existingHashes.has(hash)) {
        duplicates.push(row);
      } else {
        unique.push(row);
      }
    }
  }

  // A bank file and an aggregator describe, date and identify the same
  // transaction differently, so exact id/description matching misses overlap
  // with rows the bank sync already stored. Catch those by amount + nearby date.
  if (unique.length > 0) {
    const synced = await db
      .select({ id: transactions.id, date: transactions.date, amount: transactions.normalizedAmount })
      .from(transactions)
      .where(and(eq(transactions.accountId, accountId), inArray(transactions.provider, ["simplefin", "plaid"])));
    const matches = matchNearDuplicates(
      // Imported rows are positive-is-expense; stored ones compare via normalizedAmount.
      unique.map((r) => ({ key: r.id, date: r.date, amount: normalizeAmount(r.amount) })),
      synced.map((s) => ({ key: s.id, date: s.date, amount: s.amount })),
    );
    if (matches.size > 0) {
      const stillUnique: NormalizedRow[] = [];
      for (const row of unique) {
        if (matches.has(row.id)) duplicates.push(row);
        else stillUnique.push(row);
      }
      return { unique: stillUnique, duplicates };
    }
  }

  return { unique, duplicates };
}
