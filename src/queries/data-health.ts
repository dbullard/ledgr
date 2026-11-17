import { desc, inArray } from "drizzle-orm";
import { db as defaultDb, type LedgrDb } from "@/db";
import { bankConnections, syncLog, type BankProvider } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { evaluateConnectionHealth, type Health } from "@/lib/data-health";

export interface ConnectionHealthRow {
  connectionId: string;
  institutionName: string;
  provider: BankProvider;
  lastSyncAt: Date | null;
  lastDataAt: Date | null;
  health: Health;
}

const LEVEL_ORDER = { problem: 0, warning: 1, ok: 2 } as const;

/**
 * One verdict per bank connection, worst first, so whatever needs attention
 * is at the top of the Settings > Data health card.
 */
export async function getConnectionHealth(
  householdId: string,
  now: Date = new Date(),
  db: LedgrDb = defaultDb,
): Promise<ConnectionHealthRow[]> {
  const scoped = scopedQuery(householdId, db);
  const connections = await db
    .select({
      id: bankConnections.id,
      provider: bankConnections.provider,
      institutionName: bankConnections.institutionName,
      status: bankConnections.status,
      errorCode: bankConnections.errorCode,
      errorMessage: bankConnections.errorMessage,
      lastDataAt: bankConnections.lastDataAt,
    })
    .from(bankConnections)
    .where(scoped.where(bankConnections));
  if (connections.length === 0) return [];

  // sync_log has no household column; it is reached through connections that
  // were already scoped to this household above.
  const latest = await db
    .selectDistinctOn([syncLog.connectionId], {
      connectionId: syncLog.connectionId,
      syncedAt: syncLog.syncedAt,
      error: syncLog.error,
    })
    .from(syncLog)
    .where(inArray(syncLog.connectionId, connections.map((c) => c.id)))
    .orderBy(syncLog.connectionId, desc(syncLog.syncedAt));
  const latestByConnection = new Map(latest.map((l) => [l.connectionId, l]));

  return connections
    .map((c) => {
      const last = latestByConnection.get(c.id);
      return {
        connectionId: c.id,
        institutionName: c.institutionName ?? "Unnamed institution",
        provider: c.provider,
        lastSyncAt: last?.syncedAt ?? null,
        lastDataAt: c.lastDataAt,
        health: evaluateConnectionHealth(
          {
            status: c.status,
            errorCode: c.errorCode,
            errorMessage: c.errorMessage,
            lastSyncAt: last?.syncedAt ?? null,
            lastSyncError: last?.error ?? null,
            lastDataAt: c.lastDataAt,
          },
          now,
        ),
      };
    })
    .sort(
      (a, b) =>
        LEVEL_ORDER[a.health.level] - LEVEL_ORDER[b.health.level] ||
        a.institutionName.localeCompare(b.institutionName),
    );
}
