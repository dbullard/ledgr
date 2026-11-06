import { describe, expect, it } from "vitest";
import { getConnectionAlerts, type SyncOutcome } from "./connection-alerts";
import type { InstitutionGroup } from "@/queries/accounts";

function group(over: Partial<InstitutionGroup>): InstitutionGroup {
  return {
    institutionName: "Bank",
    connectionId: "c1",
    provider: "simplefin",
    status: "active",
    lastSyncedAt: null,
    errorCode: null,
    errorMessage: null,
    lastDataAt: null,
    logoBase64: null,
    primaryColor: null,
    accounts: [],
    ...over,
  };
}

const none = new Map<string, SyncOutcome>();

describe("getConnectionAlerts", () => {
  it("returns nothing when every connection is healthy", () => {
    expect(getConnectionAlerts([group({})], none)).toEqual([]);
  });

  it("skips manual accounts that have no connection", () => {
    expect(getConnectionAlerts([group({ connectionId: null, status: "error" })], none)).toEqual([]);
  });

  it("flags a SimpleFIN bank that needs reauth with the provider's wording", () => {
    const [alert] = getConnectionAlerts(
      [group({ institutionName: "Arvest", status: "reauth_required", errorCode: "BANK_AUTH_REQUIRED", errorMessage: "Login expired" })],
      none,
    );
    expect(alert.institutionName).toBe("Arvest");
    expect(alert.label).toBe("Bank login expired");
    expect(alert.tone).toBe("destructive");
    expect(alert.detail).toContain("Login expired");
  });

  it("falls back to a generic message when the status has no error code", () => {
    const [alert] = getConnectionAlerts([group({ provider: "plaid", status: "reauth_required" })], none);
    expect(alert.label).toBe("Reconnect needed");
  });

  it("flags a just-failed sync even though the stored status is still active", () => {
    const states = new Map<string, SyncOutcome>([["c1", { status: "error", error: "boom" }]]);
    const [alert] = getConnectionAlerts([group({})], states);
    expect(alert).toMatchObject({ label: "Sync failed", detail: "boom", tone: "warning" });
  });

  it("does not duplicate a connection that is both unhealthy and failed to sync", () => {
    const states = new Map<string, SyncOutcome>([["c1", { status: "error", error: "x" }]]);
    expect(getConnectionAlerts([group({ status: "revoked", errorCode: "ACCESS_REVOKED" })], states)).toHaveLength(1);
  });

  it("lists destructive alerts before warnings", () => {
    const alerts = getConnectionAlerts(
      [
        group({ connectionId: "a", institutionName: "A", status: "error", errorCode: "HTTP_500" }),
        group({ connectionId: "b", institutionName: "B", status: "reauth_required", errorCode: "BANK_AUTH_REQUIRED" }),
      ],
      none,
    );
    expect(alerts.map((a) => a.institutionName)).toEqual(["B", "A"]);
  });
});
