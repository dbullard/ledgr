import { describe, it, expect, afterEach, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { createTestDb } from "./setup";
import { server } from "../mocks/server";
import { provisionHousehold } from "@/lib/auth/provision";
import { decrypt } from "@/lib/encryption";
import { bankConnections, accounts, balanceHistory, transactions } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { exchangeAndStoreAccounts } from "@/actions/plaid";
import { mapPlaidAccountType } from "@/lib/plaid/utils";
import { resetPlaidClient } from "@/lib/plaid/client";
import { insertSoftDeletedAccount, insertTransaction } from "./helpers";
import type { LedgrDb } from "@/db";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(() => Promise.resolve({ user: { id: "test-user-id" } })),
  getHouseholdId: vi.fn(),
}));
vi.mock("@/lib/demo-mode", () => ({ guardDemoMode: vi.fn(() => null) }));

beforeAll(() => {
  vi.stubEnv("PLAID_CLIENT_ID", "test-id");
  vi.stubEnv("PLAID_SECRET", "test-secret");
  vi.stubEnv("PLAID_ENV", "sandbox");
  vi.stubEnv("ENCRYPTION_KEY", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2");
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
});

describe("plaid exchange flow", () => {
  let db: LedgrDb;
  let close: (() => Promise<void>) | undefined;

  beforeEach(() => {
    resetPlaidClient();
  });

  afterEach(async () => {
    server.resetHandlers();
    // Null out after closing: the pure-unit "maps account types" test never
    // calls setup(), so without this the stale (already ended) pool from the
    // previous test would be closed a second time and throw.
    await close?.();
    close = undefined;
  });

  async function setup() {
    ({ db, close } = await createTestDb());
    return db;
  }

  it("stores plaid item with encrypted token and creates accounts with correct balances", async () => {
    await setup();
    const hh = await provisionHousehold("user-1", db);

    const result = await exchangeAndStoreAccounts("public-sandbox-token", hh, db);
    expect(result.success).toBe(true);
    expect(result.accountCount).toBe(4);

    const items = await db.select().from(bankConnections).where(eq(bankConnections.householdId, hh));
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("active");
    expect(items[0].institutionName).toBe("Chase");
    expect(items[0].plaidInstitutionId).toBe("ins_1");

    const decrypted = decrypt(items[0].credential);
    expect(decrypted).toBe("access-sandbox-test-token-abc123");

    const accts = await db.select().from(accounts).where(eq(accounts.householdId, hh));
    expect(accts).toHaveLength(4);

    const checking = accts.find((a) => a.externalAccountId === "plaid-acc-checking")!;
    expect(checking.currentBalance).toBe(100000);
    expect(checking.availableBalance).toBe(90000);
    expect(checking.type).toBe("checking");

    const credit = accts.find((a) => a.externalAccountId === "plaid-acc-credit")!;
    // Plaid reports $450.50 owed as +45050; Ledgr stores owed as negative so
    // net worth is the plain sum of balances. See db/schema/accounts.ts.
    expect(credit.currentBalance).toBe(-45050);
    // Credit limit is a capacity, not a debt — not sign-flipped.
    expect(credit.creditLimit).toBe(100000);
    expect(credit.type).toBe("credit");

    // The same normalized value must reach balance_history, or the net-worth
    // chart and the live figure would disagree by twice the debt.
    const creditHistory = await db
      .select()
      .from(balanceHistory)
      .where(eq(balanceHistory.accountId, credit.id));
    expect(creditHistory).toHaveLength(1);
    expect(creditHistory[0].balance).toBe(-45050);
  });

  it("stores null balances as null, not zero", async () => {
    await setup();
    const hh = await provisionHousehold("user-null", db);

    await exchangeAndStoreAccounts("public-sandbox-token", hh, db);

    const accts = await db.select().from(accounts).where(eq(accounts.householdId, hh));
    const investment = accts.find((a) => a.externalAccountId === "plaid-acc-null")!;
    expect(investment.currentBalance).toBeNull();
    expect(investment.availableBalance).toBeNull();
    expect(investment.type).toBe("investment");
  });

  it("creates balance_history for accounts with non-null balances only", async () => {
    await setup();
    const hh = await provisionHousehold("user-history", db);

    await exchangeAndStoreAccounts("public-sandbox-token", hh, db);

    const history = await db.select().from(balanceHistory);
    expect(history.length).toBe(3);
  });

  it("isolates accounts between households", async () => {
    await setup();
    const hhA = await provisionHousehold("user-a", db);
    const hhB = await provisionHousehold("user-b", db);

    await exchangeAndStoreAccounts("public-sandbox-token", hhA, db);

    const scopeB = scopedQuery(hhB, db);
    const accts = await db.select().from(accounts).where(scopeB.where(accounts));
    expect(accts).toHaveLength(0);
  });

  it("rejects duplicate institution for same household", async () => {
    await setup();
    const hh = await provisionHousehold("user-dup", db);

    await exchangeAndStoreAccounts("public-sandbox-token", hh, db);
    const result = await exchangeAndStoreAccounts("public-sandbox-token", hh, db);

    expect(result.success).toBe(false);
    expect(result.error).toContain("already connected");
  });

  // Two logins at one bank (e.g. spouses at the same credit union) share a joint
  // account but each has their own: that is not a duplicate. Re-linking the
  // same login is.
  function mockLogins(logins: Record<string, { itemId: string; accounts: { id: string; mask: string; subtype: string }[] }>) {
    let nextToken = 0;
    const order = Object.keys(logins);
    server.use(
      http.post("https://sandbox.plaid.com/item/public_token/exchange", () =>
        HttpResponse.json({ access_token: order[nextToken++ % order.length], item_id: "x", request_id: "r" }),
      ),
      http.post("https://sandbox.plaid.com/item/get", async ({ request }) => {
        const { access_token } = (await request.json()) as { access_token: string };
        return HttpResponse.json({
          item: { item_id: logins[access_token].itemId, institution_id: "ins_arvest", webhook: "", available_products: [], billed_products: [], consent_expiration_time: null, error: null },
          request_id: "r",
        });
      }),
      http.post("https://sandbox.plaid.com/accounts/get", async ({ request }) => {
        const { access_token } = (await request.json()) as { access_token: string };
        return HttpResponse.json({
          accounts: logins[access_token].accounts.map((a) => ({
            account_id: a.id, name: "ESSENTIAL CHECKING", official_name: null, type: "depository", subtype: a.subtype, mask: a.mask,
            balances: { current: 10, available: 10, limit: null, iso_currency_code: "USD" },
          })),
          request_id: "r",
        });
      }),
      http.post("https://sandbox.plaid.com/item/remove", () => HttpResponse.json({ request_id: "r" })),
    );
  }

  it("allows a second login at the same institution when its accounts are not all already connected", async () => {
    await setup();
    const hh = await provisionHousehold("user-two-logins", db);
    mockLogins({
      "tok-david": { itemId: "item-david", accounts: [{ id: "d-chk", mask: "1001", subtype: "checking" }, { id: "d-joint", mask: "9999", subtype: "checking" }] },
      "tok-loren": { itemId: "item-loren", accounts: [{ id: "l-chk", mask: "2002", subtype: "checking" }, { id: "l-joint", mask: "9999", subtype: "checking" }] },
    });

    const first = await exchangeAndStoreAccounts("pub-1", hh, db);
    const second = await exchangeAndStoreAccounts("pub-2", hh, db);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    const conns = await db.select().from(bankConnections).where(eq(bankConnections.householdId, hh));
    expect(conns).toHaveLength(2);
  });

  it("still rejects re-linking the same login (same accounts under a new Item) and removes the extra Item", async () => {
    await setup();
    const hh = await provisionHousehold("user-relink-same", db);
    let removed = 0;
    mockLogins({
      "tok-a": { itemId: "item-a", accounts: [{ id: "a-chk", mask: "1001", subtype: "checking" }, { id: "a-joint", mask: "9999", subtype: "checking" }] },
      "tok-a2": { itemId: "item-a2", accounts: [{ id: "a2-chk", mask: "1001", subtype: "checking" }, { id: "a2-joint", mask: "9999", subtype: "checking" }] },
    });
    server.use(http.post("https://sandbox.plaid.com/item/remove", () => { removed++; return HttpResponse.json({ request_id: "r" }); }));

    expect((await exchangeAndStoreAccounts("pub-1", hh, db)).success).toBe(true);
    const dup = await exchangeAndStoreAccounts("pub-2", hh, db);

    expect(dup.success).toBe(false);
    expect(dup.error).toContain("already connected");
    expect(removed).toBe(1);
    const conns = await db.select().from(bankConnections).where(eq(bankConnections.householdId, hh));
    expect(conns).toHaveLength(1);
  });

  it("maps account types correctly", () => {
    expect(mapPlaidAccountType("depository", "checking")).toBe("checking");
    expect(mapPlaidAccountType("depository", "savings")).toBe("savings");
    expect(mapPlaidAccountType("depository", "money market")).toBe("checking");
    expect(mapPlaidAccountType("credit", "credit card")).toBe("credit");
    expect(mapPlaidAccountType("loan", "mortgage")).toBe("loan");
    expect(mapPlaidAccountType("investment", "401k")).toBe("investment");
    expect(mapPlaidAccountType("other", null)).toBe("other");
  });

  it("resurrects soft-deleted accounts on re-link instead of creating new ones", async () => {
    await setup();
    const hh = await provisionHousehold("user-relink", db);

    const { accountId: oldCheckingId } = await insertSoftDeletedAccount(db, hh, {
      externalAccountId: "plaid-acc-checking",
      name: "Old Checking",
      type: "checking",
    });
    await insertTransaction(db, hh, oldCheckingId, {
      name: "Old Transaction",
      notes: "user-edited-note",
    });

    const result = await exchangeAndStoreAccounts("public-sandbox-token", hh, db);
    expect(result.success).toBe(true);

    const allAccts = await db
      .select()
      .from(accounts)
      .where(eq(accounts.householdId, hh));
    const activeAccts = allAccts.filter((a) => a.deletedAt === null);

    const checking = activeAccts.find((a) => a.externalAccountId === "plaid-acc-checking")!;
    expect(checking).toBeDefined();
    expect(checking.id).toBe(oldCheckingId);
    expect(checking.deletedAt).toBeNull();
    expect(checking.bankConnectionId).not.toBeNull();

    const txns = await db
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, oldCheckingId));
    expect(txns).toHaveLength(1);
    expect(txns[0].notes).toBe("user-edited-note");
  });

  it("resurrects the most recently deleted account when duplicates exist", async () => {
    await setup();
    const hh = await provisionHousehold("user-dup-deleted", db);

    const olderDate = new Date("2026-01-01");
    const newerDate = new Date("2026-05-01");

    const { accountId: olderId } = await insertSoftDeletedAccount(db, hh, {
      externalAccountId: "plaid-acc-checking",
      name: "Older Checking",
      type: "checking",
      deletedAt: olderDate,
    });
    const { accountId: newerId } = await insertSoftDeletedAccount(db, hh, {
      externalAccountId: "plaid-acc-checking",
      name: "Newer Checking",
      type: "checking",
      deletedAt: newerDate,
    });

    const result = await exchangeAndStoreAccounts("public-sandbox-token", hh, db);
    expect(result.success).toBe(true);

    const allAccts = await db.select().from(accounts).where(eq(accounts.householdId, hh));
    const checking = allAccts.find(
      (a) => a.externalAccountId === "plaid-acc-checking" && a.deletedAt === null,
    )!;
    expect(checking.id).toBe(newerId);

    const older = allAccts.find((a) => a.id === olderId)!;
    expect(older.deletedAt).not.toBeNull();
  });
});
