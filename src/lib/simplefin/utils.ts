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

/**
 * Bank data older than this (by SimpleFIN's balance-date) is reported as stale.
 * The Bridge refreshes about every 24h; banks that need re-authentication
 * (Arvest, every ~2 days) often just stop updating without an error, so wait
 * a day and a half rather than three days before saying something.
 */
export const STALE_DATA_HOURS = 36;

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
 * An error with a conn_id counts if one of this connection's own accounts
 * belongs to that conn_id (one Access URL can span several banks) or if the
 * conn_id can't be matched to any account at all; an act.* error counts only
 * for the account it names; an error with neither applies to the whole
 * credential.
 */
export function assessConnectionHealth(
  response: SimplefinAccountsResponse,
  ownedExternalAccountIds: ReadonlySet<string>,
  now: Date,
): ConnectionHealth {
  const owned = response.accounts.filter((a) => ownedExternalAccountIds.has(a.id));
  const ownedConnIds = new Set(owned.map((a) => a.conn_id).filter((c): c is string => !!c));

  // Every conn_id the response mentions on an account. A con.* error whose
  // conn_id is absent here means the bridge dropped that connection's accounts
  // (typical when its login is broken), so we can't prove it isn't ours.
  const presentConnIds = new Set(response.accounts.map((a) => a.conn_id).filter((c): c is string => !!c));
  const appliesToUs = (e: { conn_id?: string | null; account_id?: string | null }): boolean => {
    if (e.account_id) return ownedExternalAccountIds.has(e.account_id);
    if (!e.conn_id) return true;
    if (ownedConnIds.has(e.conn_id)) return true;
    // Our accounts carry no conn_id, or the error's connection has no accounts
    // in this response: surface it rather than silently reporting "healthy".
    return ownedConnIds.size === 0 || !presentConnIds.has(e.conn_id);
  };

  const reported: { code: string; msg: string }[] = [
    ...(response.errlist ?? []).filter(appliesToUs).map((e) => ({ code: e.code ?? "", msg: e.msg })),
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
    const ageHours = Math.floor((now.getTime() - lastDataAt.getTime()) / 3_600_000);
    if (ageHours >= STALE_DATA_HOURS) {
      const age = ageHours >= 48 ? `${Math.floor(ageHours / 24)} days` : `${ageHours} hours`;
      return {
        lastDataAt,
        issue: {
          status: "error",
          errorCode: "NO_RECENT_DATA",
          message: `The bank has not refreshed in ${age} and SimpleFIN reported no error. It may need reauthorizing on the SimpleFIN Bridge.`,
        },
      };
    }
  }
  return { lastDataAt, issue: null };
}
