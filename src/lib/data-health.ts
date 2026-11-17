/**
 * Pure "is my data safe and current?" checks behind the Settings > Data health
 * card: one verdict per bank connection, and one for the nightly backup.
 * Nothing here touches the database or the filesystem, so the thresholds are
 * unit-tested directly.
 */
import { describeConnectionIssue } from "@/lib/connection-issue";
import type { ConnectionStatus } from "@/db/schema/bank-connections";

export type HealthLevel = "ok" | "warning" | "problem";

export interface Health {
  level: HealthLevel;
  /** One short line for the row; the worst thing wrong, or "Up to date". */
  summary: string;
}

const HOUR = 3_600_000;
const RANK: Record<HealthLevel, number> = { ok: 0, warning: 1, problem: 2 };

function days(ms: number): number {
  return Math.max(1, Math.round(ms / (24 * HOUR)));
}

function agoLabel(ms: number): string {
  const d = days(ms);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** The worst of several findings; the first one wins a tie. */
function worst(findings: Health[], fallback: Health): Health {
  let best = fallback;
  for (const f of findings) if (RANK[f.level] > RANK[best.level]) best = f;
  return best;
}

// ---------------------------------------------------------------------------
// Bank connections
// ---------------------------------------------------------------------------

/** Sync older than this is worth a look. */
const SYNC_WARN_HOURS = 48;
/** Sync older than this means something is broken. */
const SYNC_PROBLEM_DAYS = 7;
/** The bank itself hasn't refreshed for this long (SimpleFIN reports it). */
const DATA_STALE_DAYS = 7;

export interface ConnectionHealthInput {
  status: ConnectionStatus | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Newest sync_log row, successful or not. */
  lastSyncAt: Date | null;
  /** The error recorded on the newest sync_log row, if it failed. */
  lastSyncError: string | null;
  /** When the bank last refreshed its data. Null when the provider doesn't say. */
  lastDataAt: Date | null;
}

const STATUS_SUMMARY: Partial<Record<ConnectionStatus, string>> = {
  reauth_required: "Reconnect needed",
  revoked: "Access revoked",
  error: "Sync problem",
};

export function evaluateConnectionHealth(c: ConnectionHealthInput, now: Date): Health {
  const findings: Health[] = [];

  const statusSummary = c.status ? STATUS_SUMMARY[c.status] : undefined;
  if (statusSummary) {
    const described = describeConnectionIssue({
      status: c.status,
      errorCode: c.errorCode,
      errorMessage: c.errorMessage,
    });
    findings.push({ level: "problem", summary: described?.label ?? statusSummary });
  } else if (c.status === "pending_classification") {
    findings.push({ level: "warning", summary: "Waiting for account setup" });
  }

  if (!c.lastSyncAt) {
    findings.push({ level: "warning", summary: "Never synced" });
  } else {
    const age = now.getTime() - c.lastSyncAt.getTime();
    if (age > SYNC_PROBLEM_DAYS * 24 * HOUR) {
      findings.push({ level: "problem", summary: `Last synced ${agoLabel(age)}` });
    } else if (age > SYNC_WARN_HOURS * HOUR) {
      findings.push({ level: "warning", summary: `Last synced ${agoLabel(age)}` });
    }
  }

  if (c.lastSyncError) {
    findings.push({ level: "warning", summary: `Last sync failed: ${c.lastSyncError}` });
  }

  if (c.lastDataAt) {
    const age = now.getTime() - c.lastDataAt.getTime();
    if (age > DATA_STALE_DAYS * 24 * HOUR) {
      const d = days(age);
      findings.push({ level: "warning", summary: `Bank data is ${d} day${d === 1 ? "" : "s"} old` });
    }
  }

  return worst(findings, { level: "ok", summary: "Up to date" });
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

/** What the backup sidecar writes to status.json after every attempt. */
export interface BackupStatus {
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
  file: string | null;
  sizeBytes: number | null;
  /** Dumps currently kept on disk. */
  count: number;
}

const BACKUP_WARN_HOURS = 36;
const BACKUP_PROBLEM_HOURS = 72;

function asDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parses the sidecar's status file. Anything unusable reads as "no status". */
export function parseBackupStatus(raw: string): BackupStatus | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  return {
    lastSuccessAt: asDate(o.lastSuccessAt),
    lastAttemptAt: asDate(o.lastAttemptAt),
    lastError: typeof o.lastError === "string" && o.lastError ? o.lastError : null,
    file: typeof o.file === "string" ? o.file : null,
    sizeBytes: typeof o.sizeBytes === "number" ? o.sizeBytes : null,
    count: typeof o.count === "number" ? o.count : 0,
  };
}

export function evaluateBackupHealth(status: BackupStatus | null, now: Date): Health {
  if (!status) return { level: "warning", summary: "Backups not set up" };

  const findings: Health[] = [];
  if (status.lastError) {
    findings.push({ level: "problem", summary: `Last backup failed: ${status.lastError}` });
  }
  if (!status.lastSuccessAt) {
    findings.push({ level: "problem", summary: "No successful backup yet" });
  } else {
    const age = now.getTime() - status.lastSuccessAt.getTime();
    if (age > BACKUP_PROBLEM_HOURS * HOUR) {
      findings.push({ level: "problem", summary: `Last backup ${agoLabel(age)}` });
    } else if (age > BACKUP_WARN_HOURS * HOUR) {
      findings.push({ level: "warning", summary: `Last backup ${agoLabel(age)}` });
    }
  }

  return worst(findings, { level: "ok", summary: "Backed up" });
}
