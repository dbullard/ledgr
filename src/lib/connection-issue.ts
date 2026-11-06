import type { ConnectionStatus } from "@/db/schema/bank-connections";

export interface ConnectionIssueLabel {
  label: string;
  /** What to do / what the provider said; shown in the tooltip. */
  detail: string;
  tone: "warning" | "destructive";
}

interface Input {
  status: ConnectionStatus | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Maps a connection's stored errorCode to a specific label so the user can
 * tell *why* it isn't updating (bank login expired vs. SimpleFIN down vs. data
 * simply stale). Returns null when the generic status badge is enough.
 */
export function describeConnectionIssue({ status, errorCode, errorMessage }: Input): ConnectionIssueLabel | null {
  if (!errorCode || status === "active" || status === null) return null;
  const said = errorMessage ? `Reported: ${errorMessage}` : "";

  switch (errorCode) {
    case "ACCESS_REVOKED":
      return {
        label: "SimpleFIN access revoked",
        detail: "SimpleFIN rejected Ledgr's access token. Reconnect this institution.",
        tone: "destructive",
      };
    case "BANK_AUTH_REQUIRED":
      return {
        label: "Bank login expired",
        detail: `Reauthorize this bank on the SimpleFIN site. ${said}`.trim(),
        tone: "destructive",
      };
    case "BANK_MFA_REQUIRED":
      return {
        label: "Bank needs verification",
        detail: `The bank is asking for MFA. Complete it on the SimpleFIN site. ${said}`.trim(),
        tone: "destructive",
      };
    case "BANK_REPORTED_ERROR":
      return { label: "Bank reported an error", detail: said || "SimpleFIN reported a problem with this bank.", tone: "warning" };
    case "NO_RECENT_DATA":
      return {
        label: "No recent bank data",
        detail: errorMessage ?? "The bank has not refreshed recently and SimpleFIN reported no error. It may need reauthorizing on the SimpleFIN Bridge.",
        tone: "warning",
      };
    case "HTTP_429":
      return { label: "SimpleFIN rate limited", detail: "Too many requests. Ledgr will retry on the next sync.", tone: "warning" };
    default: {
      const http = /^HTTP_(\d{3})$/.exec(errorCode);
      if (http) {
        return {
          label: Number(http[1]) >= 500 ? "SimpleFIN unavailable" : `SimpleFIN error (${http[1]})`,
          detail: errorMessage ?? "SimpleFIN returned an unexpected response.",
          tone: "warning",
        };
      }
      return null;
    }
  }
}
