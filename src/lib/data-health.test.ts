import { describe, it, expect } from "vitest";
import {
  evaluateConnectionHealth,
  evaluateBackupHealth,
  parseBackupStatus,
  type ConnectionHealthInput,
} from "./data-health";

const NOW = new Date("2026-11-17T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);

function conn(overrides: Partial<ConnectionHealthInput> = {}): ConnectionHealthInput {
  return {
    status: "active",
    errorCode: null,
    errorMessage: null,
    lastSyncAt: hoursAgo(3),
    lastSyncError: null,
    lastDataAt: hoursAgo(5),
    ...overrides,
  };
}

describe("evaluateConnectionHealth", () => {
  it("is ok for a recently synced, healthy connection", () => {
    expect(evaluateConnectionHealth(conn(), NOW)).toMatchObject({ level: "ok" });
  });

  it.each(["reauth_required", "revoked", "error"] as const)("is a problem when status is %s", (status) => {
    expect(evaluateConnectionHealth(conn({ status }), NOW).level).toBe("problem");
  });

  it("uses the specific connection-issue wording when there is an error code", () => {
    const h = evaluateConnectionHealth(conn({ status: "reauth_required", errorCode: "BANK_AUTH_REQUIRED" }), NOW);
    expect(h.summary).toBe("Bank login expired");
  });

  it("warns when the newest sync is older than 2 days and flags a problem past 7", () => {
    expect(evaluateConnectionHealth(conn({ lastSyncAt: hoursAgo(47) }), NOW).level).toBe("ok");
    expect(evaluateConnectionHealth(conn({ lastSyncAt: hoursAgo(49) }), NOW)).toMatchObject({
      level: "warning",
      summary: "Last synced 2 days ago",
    });
    expect(evaluateConnectionHealth(conn({ lastSyncAt: daysAgo(8) }), NOW)).toMatchObject({
      level: "problem",
      summary: "Last synced 8 days ago",
    });
  });

  it("warns when a connection has never synced", () => {
    expect(evaluateConnectionHealth(conn({ lastSyncAt: null }), NOW)).toMatchObject({
      level: "warning",
      summary: "Never synced",
    });
  });

  it("warns when the last sync attempt failed even though the status is still active", () => {
    const h = evaluateConnectionHealth(conn({ lastSyncError: "RATE_LIMIT" }), NOW);
    expect(h.level).toBe("warning");
    expect(h.summary).toContain("RATE_LIMIT");
  });

  it("warns when the bank itself has not refreshed in over a week", () => {
    const h = evaluateConnectionHealth(conn({ lastDataAt: daysAgo(9) }), NOW);
    expect(h.level).toBe("warning");
    expect(h.summary).toBe("Bank data is 9 days old");
  });

  it("ignores a missing lastDataAt (Plaid does not report it)", () => {
    expect(evaluateConnectionHealth(conn({ lastDataAt: null }), NOW).level).toBe("ok");
  });

  it("reports the worst problem when several apply", () => {
    const h = evaluateConnectionHealth(conn({ status: "revoked", lastSyncAt: daysAgo(30) }), NOW);
    expect(h.level).toBe("problem");
    expect(h.summary).toBe("Access revoked");
  });
});

describe("parseBackupStatus", () => {
  it("reads the sidecar's status file", () => {
    const s = parseBackupStatus(
      JSON.stringify({
        lastSuccessAt: "2026-11-17T03:00:12Z",
        lastAttemptAt: "2026-11-17T03:00:00Z",
        lastError: null,
        file: "ledgr-20261117-030000.dump",
        sizeBytes: 5_242_880,
        count: 7,
      }),
    );
    expect(s).toMatchObject({ file: "ledgr-20261117-030000.dump", sizeBytes: 5_242_880, count: 7, lastError: null });
    expect(s!.lastSuccessAt).toEqual(new Date("2026-11-17T03:00:12Z"));
  });

  it("returns null for junk, so a corrupt file reads as 'no status', not a crash", () => {
    expect(parseBackupStatus("not json")).toBeNull();
    expect(parseBackupStatus("[]")).toBeNull();
    expect(parseBackupStatus("null")).toBeNull();
  });

  it("tolerates missing optional fields", () => {
    const s = parseBackupStatus(JSON.stringify({ lastAttemptAt: "2026-11-17T03:00:00Z", lastError: "pg_dump failed" }));
    expect(s).toMatchObject({ lastSuccessAt: null, lastError: "pg_dump failed" });
  });
});

describe("evaluateBackupHealth", () => {
  const ok = (h: number) => ({
    lastSuccessAt: hoursAgo(h), lastAttemptAt: hoursAgo(h), lastError: null,
    file: "x.dump", sizeBytes: 1024, count: 3,
  });

  it("warns that backups are not set up when there is no status", () => {
    expect(evaluateBackupHealth(null, NOW)).toMatchObject({ level: "warning", summary: "Backups not set up" });
  });

  it("is ok for a backup within the last day and a half", () => {
    expect(evaluateBackupHealth(ok(10), NOW)).toMatchObject({ level: "ok" });
    expect(evaluateBackupHealth(ok(35), NOW).level).toBe("ok");
  });

  it("warns past 36 hours and is a problem past 3 days", () => {
    expect(evaluateBackupHealth(ok(40), NOW)).toMatchObject({ level: "warning", summary: "Last backup 2 days ago" });
    expect(evaluateBackupHealth(ok(80), NOW)).toMatchObject({ level: "problem", summary: "Last backup 3 days ago" });
  });

  it("is a problem when the last attempt failed", () => {
    const h = evaluateBackupHealth({ ...ok(30), lastAttemptAt: hoursAgo(1), lastError: "disk full" }, NOW);
    expect(h).toMatchObject({ level: "problem" });
    expect(h.summary).toContain("disk full");
  });

  it("is a problem when there has never been a successful backup", () => {
    const h = evaluateBackupHealth(
      { lastSuccessAt: null, lastAttemptAt: hoursAgo(1), lastError: null, file: null, sizeBytes: null, count: 0 },
      NOW,
    );
    expect(h).toMatchObject({ level: "problem", summary: "No successful backup yet" });
  });
});
