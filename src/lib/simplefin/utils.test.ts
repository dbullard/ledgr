import { describe, it, expect } from "vitest";
import { classifyPollError, assessConnectionHealth } from "./utils";
import { SimplefinHttpError } from "./client";

describe("classifyPollError", () => {
  it("classifies a 403 from /accounts as revoked", () => {
    const result = classifyPollError(new SimplefinHttpError(403, "forbidden"));
    expect(result.status).toBe("revoked");
    expect(result.errorCode).toBe("ACCESS_REVOKED");
  });

  it("classifies a non-403 HTTP error as error, tagged with the status code", () => {
    const result = classifyPollError(new SimplefinHttpError(500, "server error"));
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("HTTP_500");
    expect(result.message).toBe("server error");
  });

  it("classifies a generic Error as error with an unknown code", () => {
    const result = classifyPollError(new Error("network down"));
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("UNKNOWN");
    expect(result.message).toBe("network down");
  });

  it("classifies a non-Error throw with a generic message", () => {
    const result = classifyPollError("some string throw");
    expect(result.status).toBe("error");
    expect(result.message).toBe("Unknown SimpleFIN sync error");
  });
});

describe("assessConnectionHealth", () => {
  const now = new Date("2026-11-02T12:00:00Z");
  const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
  const acct = (id: string, date: string, conn_id?: string) => ({
    id, name: id, currency: "USD", balance: "1.00", "balance-date": sec(date), conn_id,
  });
  const owned = new Set(["a1"]);

  it("is healthy with fresh data and no errors", () => {
    const h = assessConnectionHealth({ accounts: [acct("a1", "2026-11-02T06:00:00Z")] }, owned, now);
    expect(h.issue).toBeNull();
    expect(h.lastDataAt?.toISOString()).toBe("2026-11-02T06:00:00.000Z");
  });

  it("reports an expired bank login from errlist", () => {
    const h = assessConnectionHealth(
      { accounts: [acct("a1", "2026-10-20T00:00:00Z", "c1")], errlist: [{ code: "gen.auth", msg: "You must reauthenticate.", conn_id: "c1" }] },
      owned, now,
    );
    expect(h.issue).toMatchObject({ status: "reauth_required", errorCode: "BANK_AUTH_REQUIRED" });
  });

  it("reports MFA separately from login expiry", () => {
    const h = assessConnectionHealth({ accounts: [acct("a1", "2026-11-02T00:00:00Z")], errors: ["Two-factor verification required"] }, owned, now);
    expect(h.issue?.errorCode).toBe("BANK_MFA_REQUIRED");
  });

  it("ignores errors that belong to another institution's conn_id", () => {
    const h = assessConnectionHealth(
      { accounts: [acct("a1", "2026-11-02T00:00:00Z", "c1"), acct("b1", "2026-11-02T00:00:00Z", "c2")], errlist: [{ code: "gen.auth", msg: "reauth", conn_id: "c2" }] },
      owned, now,
    );
    expect(h.issue).toBeNull();
  });

  it("surfaces an unclassified bank error with its message", () => {
    const h = assessConnectionHealth({ accounts: [acct("a1", "2026-11-02T00:00:00Z")], errors: ["Bank site is down"] }, owned, now);
    expect(h.issue).toMatchObject({ status: "error", errorCode: "BANK_REPORTED_ERROR", message: "Bank site is down" });
  });

  it("flags silently stale data when no error is reported", () => {
    const h = assessConnectionHealth({ accounts: [acct("a1", "2026-10-25T00:00:00Z")] }, owned, now);
    expect(h.issue).toMatchObject({ errorCode: "NO_RECENT_DATA" });
  });

  it("flags a bank that has not refreshed in ~45h, before the old 3-day threshold", () => {
    const h = assessConnectionHealth({ accounts: [acct("a1", "2026-10-31T15:00:00Z")] }, owned, now);
    expect(h.issue).toMatchObject({ status: "error", errorCode: "NO_RECENT_DATA" });
    expect(h.issue?.message).toMatch(/reauthoriz/i);
  });

  it("does not flag data refreshed within the last day and a half", () => {
    const h = assessConnectionHealth({ accounts: [acct("a1", "2026-11-01T02:00:00Z")] }, owned, now);
    expect(h.issue).toBeNull();
  });

  it("treats balance-date 0 as unknown, not stale", () => {
    const h = assessConnectionHealth({ accounts: [{ ...acct("a1", "2026-11-02T00:00:00Z"), "balance-date": 0 }] }, owned, now);
    expect(h.issue).toBeNull();
    expect(h.lastDataAt).toBeNull();
  });

  it("reports con.auth even when the bridge omits that connection's accounts", () => {
    // The only account in the response belongs to another bank; c1's accounts
    // were left out because its login is broken. The error must not vanish.
    const h = assessConnectionHealth(
      { accounts: [acct("b1", "2026-11-02T00:00:00Z", "c2")], errlist: [{ code: "con.auth", msg: "Authentication issue", conn_id: "c1" }] },
      owned, now,
    );
    expect(h.issue).toMatchObject({ status: "reauth_required", errorCode: "BANK_AUTH_REQUIRED" });
  });

  it("applies a conn_id error when our accounts carry no conn_id to compare against", () => {
    const h = assessConnectionHealth(
      { accounts: [acct("a1", "2026-11-02T00:00:00Z")], errlist: [{ code: "con.auth", msg: "Authentication issue", conn_id: "c1" }] },
      owned, now,
    );
    expect(h.issue?.errorCode).toBe("BANK_AUTH_REQUIRED");
  });

  it("scopes act.* errors to the account they name", () => {
    const other = assessConnectionHealth(
      { accounts: [acct("a1", "2026-11-02T00:00:00Z")], errlist: [{ code: "act.failed", msg: "try later", account_id: "zzz" }] },
      owned, now,
    );
    expect(other.issue).toBeNull();
    const mine = assessConnectionHealth(
      { accounts: [acct("a1", "2026-11-02T00:00:00Z")], errlist: [{ code: "act.failed", msg: "try later", account_id: "a1" }] },
      owned, now,
    );
    expect(mine.issue?.errorCode).toBe("BANK_REPORTED_ERROR");
  });
});
