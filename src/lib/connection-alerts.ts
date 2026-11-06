import { describeConnectionIssue } from "@/lib/connection-issue";
import type { InstitutionGroup } from "@/queries/accounts";

export interface SyncOutcome {
  status: "idle" | "syncing" | "success" | "error";
  error?: string;
}

export interface ConnectionAlert {
  connectionId: string;
  institutionName: string;
  provider: InstitutionGroup["provider"];
  status: InstitutionGroup["status"];
  label: string;
  detail: string;
  tone: "warning" | "destructive";
}

const STATUS_FALLBACK: Record<string, { label: string; detail: string; tone: "warning" | "destructive" }> = {
  reauth_required: {
    label: "Reconnect needed",
    detail: "This bank needs you to sign in again before it can sync.",
    tone: "destructive",
  },
  revoked: { label: "Access revoked", detail: "Access to this bank was revoked. Reconnect it to resume syncing.", tone: "destructive" },
  error: { label: "Sync problem", detail: "The last sync reported an error.", tone: "warning" },
};

/**
 * Connections the user has to do something about, worst first. A connection
 * shows up when its stored status is not healthy, or when the sync the user
 * just ran failed (the stored status may not have been refreshed yet).
 */
export function getConnectionAlerts(
  groups: InstitutionGroup[],
  syncStates: ReadonlyMap<string, SyncOutcome>,
): ConnectionAlert[] {
  const alerts: ConnectionAlert[] = [];

  for (const g of groups) {
    if (!g.connectionId) continue;
    const syncError = syncStates.get(g.connectionId);
    const unhealthy = g.status === "error" || g.status === "reauth_required" || g.status === "revoked";

    if (unhealthy) {
      const described = describeConnectionIssue({ status: g.status, errorCode: g.errorCode, errorMessage: g.errorMessage });
      const fallback = STATUS_FALLBACK[g.status as string];
      alerts.push({
        connectionId: g.connectionId,
        institutionName: g.institutionName,
        provider: g.provider,
        status: g.status,
        label: described?.label ?? fallback.label,
        detail: described?.detail ?? (g.errorMessage ? `Reported: ${g.errorMessage}` : fallback.detail),
        tone: described?.tone ?? fallback.tone,
      });
    } else if (syncError?.status === "error") {
      alerts.push({
        connectionId: g.connectionId,
        institutionName: g.institutionName,
        provider: g.provider,
        status: g.status,
        label: "Sync failed",
        detail: syncError.error ?? "An error occurred during sync.",
        tone: "warning",
      });
    }
  }

  return alerts.sort((a, b) => Number(b.tone === "destructive") - Number(a.tone === "destructive"));
}
