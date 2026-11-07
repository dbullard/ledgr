import { and, asc, eq, inArray, lt, ne } from "drizzle-orm";
import { db as defaultDb, type LedgrDb } from "@/db";
import { bankConnections } from "@/db/schema/bank-connections";
import { DEMO_HOUSEHOLD_ID } from "@/lib/demo-mode";

const STALE_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type ActiveSimplefinConnectionRef = {
  connectionId: string;
  householdId: string;
};

/**
 * Lists SimpleFIN connections eligible for scheduled sync: status "active" or
 * "error" (transient: bank hiccup, SimpleFIN 5xx, stale data — these must keep
 * being retried or they never recover) and not in the demo household.
 * "reauth_required" is polled too: the user re-authorizes at the SimpleFIN
 * Bridge, not in Ledgr, so only a poll can notice it is fixed. "revoked"
 * (403) needs a new Setup Token, so it is skipped. Used by the daily SimpleFIN sync
 * task — SimpleFIN has no webhooks, so this poll is the only sync trigger.
 */
export async function listActiveSimplefinConnections(
  db: LedgrDb = defaultDb,
): Promise<ActiveSimplefinConnectionRef[]> {
  const rows = await db
    .select({ connectionId: bankConnections.id, householdId: bankConnections.householdId })
    .from(bankConnections)
    .where(
      and(
        inArray(bankConnections.status, ["active", "error", "reauth_required"]),
        eq(bankConnections.provider, "simplefin"),
        ne(bankConnections.householdId, DEMO_HOUSEHOLD_ID),
      ),
    )
    .orderBy(asc(bankConnections.id));

  return rows;
}

/**
 * Deletes `bank_connections` rows still stuck in `pending_classification`
 * (a user pasted a Setup Token but never finished the account-classification
 * step) after a 24h TTL — otherwise their encrypted credential lingers
 * indefinitely. Returns the number of rows deleted.
 */
export async function cleanupStaleDraftConnections(
  db: LedgrDb = defaultDb,
  maxAgeMs: number = STALE_DRAFT_MAX_AGE_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const result = await db
    .delete(bankConnections)
    .where(and(eq(bankConnections.status, "pending_classification"), lt(bankConnections.createdAt, cutoff)));

  return result.rowCount ?? 0;
}
