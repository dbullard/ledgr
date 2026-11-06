import { SimplefinHttpError } from "./client";
import type { ConnectionStatus } from "@/db/schema";
import type { SimplefinAccountsResponse } from "./schemas";

/**
 * SimpleFIN has no webhooks — item-health signals (revoked/expired access)
 * must be inferred from HTTP response codes during a poll, per the protocol's
 * required checklist: "Handles a 403 response from /accounts."
 */
export function classifyPollError(err: unknown): {
  status: Extract<ConnectionStatus, "revoked" | "error">;
  errorCode: string;
  message: string;
} {
  if (err instanceof SimplefinHttpError && err.status === 403) {
    return { status: "revoked", errorCode: "ACCESS_REVOKED", message: err.message };
  }
  const message = err instanceof Error ? err.message : "Unknown SimpleFIN sync error";
  const errorCode = err instanceof SimplefinHttpError ? `HTTP_${err.status}` : "UNKNOWN";
  return { status: "error", errorCode, message };
}

/** Bank data older than this (by SimpleFIN's balance-date) is reported as stale. */
export const STALE_DATA_DAYS = 3;

export interface ConnectionIssue {
  status: Extract<ConnectionStatus, "reauth_required" | "error">;
  errorCode: "BANK_AUTH_REQUIRED" | "BANK_MFA_REQUIRED" | "BANK_REPORTED_ERROR" | "NO_RECENT_DATA";
  message: string;
}

export interface ConnectionHealth {
  /** Newest balance-date across this connection's accounts, or null if none reported. */
  lastDataAt: Date | null;
  issue: ConnectionIssue | null;
}

const MFA_PATTERN = /mfa|2fa|two.?factor|verification|security (code|question)|one.?time/i;
const AUTH_PATTERN = /auth|log ?in|sign ?in|credential|password|expired/i;

/**
 * SimpleFIN answers 200 with stale data when a bank link needs attention; the
 * reason is in `errlist` (v2) / `errors` (v1), and the age of the data is in
 * each account's `balance-date`. This turns both into one specific issue so the
 * UI can say what is wrong rather than just "stale".
 *
 * An error with a conn_id only counts if one of this connection's own accounts
 * belongs to that conn_id (one Access URL can span several banks); an error
 * without a conn_id applies to the whole credential.
 */
export function assessConnectionHealth(
  response: SimplefinAccountsResponse,
  ownedExternalAccountIds: ReadonlySet<string>,
  now: Date,
): ConnectionHealth {
  const owned = response.accounts.filter((a) => ownedExternalAccountIds.has(a.id));
  const ownedConnIds = new Set(owned.map((a) => a.conn_id).filter((c): c is string => !!c));

  const reported: { code: string; msg: string }[] = [
    ...(response.errlist ?? [])
      .filter((e) => !e.conn_id || ownedConnIds.has(e.conn_id))
      .map((e) => ({ code: e.code ?? "", msg: e.msg })),
    ...(response.errors ?? []).map((msg) => ({ code: "", msg })),
  ];

  const newest = owned.reduce((max, a) => Math.max(max, a["balance-date"]), 0);
  // balance-date 0 means "unknown" in the protocol, not 1970.
  const lastDataAt = newest > 0 ? new Date(newest * 1000) : null;

  const mfa = reported.find((e) => MFA_PATTERN.test(`${e.code} ${e.msg}`));
  if (mfa) {
    return { lastDataAt, issue: { status: "reauth_required", errorCode: "BANK_MFA_REQUIRED", message: mfa.msg } };
  }
  const auth = reported.find((e) => AUTH_PATTERN.test(`${e.code} ${e.msg}`));
  if (auth) {
    return { lastDataAt, issue: { status: "reauth_required", errorCode: "BANK_AUTH_REQUIRED", message: auth.msg } };
  }
  if (reported.length > 0) {
    return {
      lastDataAt,
      issue: { status: "error", errorCode: "BANK_REPORTED_ERROR", message: reported.map((e) => e.msg).join("; ") },
    };
  }
  if (lastDataAt) {
    const ageDays = Math.floor((now.getTime() - lastDataAt.getTime()) / 86_400_000);
    if (ageDays >= STALE_DATA_DAYS) {
      return {
        lastDataAt,
        issue: {
          status: "error",
          errorCode: "NO_RECENT_DATA",
          message: `The bank has not refreshed in ${ageDays} days, but SimpleFIN reported no error.`,
        },
      };
    }
  }
  return { lastDataAt, issue: null };
}
