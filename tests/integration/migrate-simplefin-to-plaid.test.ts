import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";
import { accounts, bankConnections, transactions, recurringTransactions } from "@/db/schema";
import {
  insertHousehold,
  insertSimplefinConnection,
  insertPlaidItem,
  insertAccount,
  insertTransaction,
  insertCategoryGroup,
  insertCategory,
  insertRecurringTransaction,
} from "./helpers";
import type { LedgrDb } from "@/db";
import { plan, apply, suggest } from "../../scripts/migrate-simplefin-to-plaid.mjs";

beforeAll(() => {
  vi.stubEnv("ENCRYPTION_KEY", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

type PgClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void };

describe("migrate-simplefin-to-plaid", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;
  let client: PgClient;

  let householdId: string;
  let sfConn: string;
  let plaidConn: string;
  let oldAcct: string;
  let newAcct: string;
  let categoryId: string;
  let adoptedOldTxn: string;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    client = await (db as unknown as { $client: { connect: () => Promise<PgClient> } }).$client.connect();
    ({ householdId } = await insertHousehold(db));
    ({ connectionId: sfConn } = await insertSimplefinConnection(db, householdId, { institutionName: "Arvest" }));
    ({ plaidItemId: plaidConn } = await insertPlaidItem(db, householdId, { institutionName: "Arvest Plaid" }));
    ({ accountId: oldAcct } = await insertAccount(db, householdId, {
      name: "David's Arvest Checking", bankConnectionId: sfConn, externalAccountId: "sf-acc", currentBalance: 21245,
    }));
    ({ accountId: newAcct } = await insertAccount(db, householdId, {
      name: "ESSENTIAL CHECKING", bankConnectionId: plaidConn, externalAccountId: "plaid-acc", currentBalance: 177582, subtype: "checking",
    }));
    const { groupId } = (await insertCategoryGroup(db, householdId)) as unknown as { groupId: string };
    ({ categoryId } = (await insertCategory(db, householdId, groupId)) as unknown as { categoryId: string });

    // Old SimpleFIN history: three rows, one categorized by the user.
    ({ transactionId: adoptedOldTxn } = (await insertTransaction(db, householdId, oldAcct, {
      externalId: "sf-1", provider: "simplefin", date: "2026-10-30", amount: -3997, normalizedAmount: -3997,
      originalName: "TIDAL WAVE ROGERS DDA PIN POS PUR", name: "Car wash", categoryId, categorySource: "manual",
    })) as unknown as { transactionId: string });
    await insertTransaction(db, householdId, oldAcct, {
      externalId: "sf-2", provider: "simplefin", date: "2022-11-01", amount: -1200, normalizedAmount: -1200, originalName: "OLD ONE",
    });
    await insertTransaction(db, householdId, oldAcct, {
      externalId: "sf-3", provider: "simplefin", date: "2026-11-02", amount: 7350, normalizedAmount: 7350, originalName: "WALMART RTN",
    });
    // New Plaid rows: one overlaps sf-1 (a day later, different wording), one is new.
    await insertTransaction(db, householdId, newAcct, {
      externalId: "plaid-1", provider: "plaid", date: "2026-10-31", amount: 3997, normalizedAmount: -3997, originalName: "TIDAL WAVE", name: "Tidal Wave",
    });
    await insertTransaction(db, householdId, newAcct, {
      externalId: "plaid-2", provider: "plaid", date: "2026-11-05", amount: 500, normalizedAmount: -500, originalName: "COFFEE",
    });
    await insertRecurringTransaction(db, householdId, { accountId: newAcct, plaidStreamId: "stream-1" });
  });

  afterEach(async () => {
    client.release();
    await close();
  });

  const pairs = () => [[oldAcct.slice(0, 8), newAcct.slice(0, 8)]];

  it("suggest reports the shared transactions between an old and a new account", async () => {
    const rows = await suggest(client);
    expect(rows).toHaveLength(1);
    expect(rows[0].shared).toBe(1);
  });

  it("plan describes the move and changes nothing", async () => {
    const out = await plan(client, { pairs: pairs(), drop: [sfConn.slice(0, 8)] });
    expect(out.pairs[0]).toMatchObject({ adopted: 1, movedIn: 1 });
    expect(await db.select().from(accounts).where(eq(accounts.id, newAcct))).toHaveLength(1);
    expect(await db.select().from(transactions).where(eq(transactions.accountId, newAcct))).toHaveLength(2);
  });

  it("apply keeps the old account and its categories, adopts matches, moves new rows, drops the old connection", async () => {
    await apply(client, { pairs: pairs(), drop: [sfConn.slice(0, 8)] });

    // New duplicate account is gone; the old one now belongs to the Plaid connection.
    expect(await db.select().from(accounts).where(eq(accounts.id, newAcct))).toHaveLength(0);
    const [a] = await db.select().from(accounts).where(eq(accounts.id, oldAcct));
    expect(a.name).toBe("David's Arvest Checking");
    expect(a.bankConnectionId).toBe(plaidConn);
    expect(a.externalAccountId).toBe("plaid-acc");
    expect(a.currentBalance).toBe(177582);

    const txns = await db.select().from(transactions).where(eq(transactions.accountId, oldAcct));
    expect(txns).toHaveLength(4); // 3 old + 1 plaid-only; the overlapping plaid row was folded in, not duplicated

    // The adopted row is the OLD row (same id, category kept) now carrying the Plaid id.
    const adopted = txns.find((t) => t.id === adoptedOldTxn)!;
    expect(adopted.externalId).toBe("plaid-1");
    expect(adopted.provider).toBe("plaid");
    expect(adopted.categoryId).toBe(categoryId);
    expect(adopted.name).toBe("Car wash");
    expect(txns.some((t) => t.externalId === "plaid-2")).toBe(true);

    // Things that pointed at the deleted account follow the kept one.
    const [rec] = await db.select().from(recurringTransactions).where(eq(recurringTransactions.householdId, householdId));
    expect(rec.accountId).toBe(oldAcct);

    // Old SimpleFIN connection removed, Plaid connection untouched.
    expect(await db.select().from(bankConnections).where(eq(bankConnections.id, sfConn))).toHaveLength(0);
    expect(await db.select().from(bankConnections).where(eq(bankConnections.id, plaidConn))).toHaveLength(1);
  });

  it("is all-or-nothing: refusing to drop a connection that still has accounts leaves everything untouched", async () => {
    await insertAccount(db, householdId, { name: "Unpaired", bankConnectionId: sfConn, externalAccountId: "sf-other" });
    await expect(apply(client, { pairs: pairs(), drop: [sfConn.slice(0, 8)] })).rejects.toThrow(/still has accounts/);

    expect(await db.select().from(accounts).where(eq(accounts.id, newAcct))).toHaveLength(1);
    const [a] = await db.select().from(accounts).where(eq(accounts.id, oldAcct));
    expect(a.bankConnectionId).toBe(sfConn);
    expect(await db.select().from(transactions).where(eq(transactions.accountId, newAcct))).toHaveLength(2);
    expect(await db.select().from(bankConnections).where(eq(bankConnections.id, sfConn))).toHaveLength(1);
  });

  it("detach turns an account into a manual one so dropping its connection cannot delete it", async () => {
    const { accountId: termLife } = await insertAccount(db, householdId, {
      name: "Term Life", bankConnectionId: sfConn, externalAccountId: "sf-term", isHidden: true,
    });
    await apply(client, { pairs: pairs(), drop: [sfConn.slice(0, 8)], detach: [termLife.slice(0, 8)] });
    const [t] = await db.select().from(accounts).where(eq(accounts.id, termLife));
    expect(t.bankConnectionId).toBeNull();
    expect(t.isHidden).toBe(true);
  });

  it("rejects a pair whose old account is not SimpleFIN or new account is not Plaid", async () => {
    await expect(plan(client, { pairs: [[newAcct.slice(0, 8), oldAcct.slice(0, 8)]] })).rejects.toThrow(/expected "simplefin"/);
  });

  it("with allowManual, a manual account (no connection) can be the account that is kept", async () => {
    const { accountId: manual } = await insertAccount(db, householdId, { name: "Qapital", type: "savings", currentBalance: 1591817 });
    await insertTransaction(db, householdId, manual, {
      externalId: null, provider: null, date: "2026-10-30", amount: 3997, normalizedAmount: -3997, originalName: "Statement row", name: "Car wash", categoryId,
    });
    // Without the flag a manual account is refused.
    await expect(plan(client, { pairs: [[manual.slice(0, 8), newAcct.slice(0, 8)]] })).rejects.toThrow(/expected "simplefin"/);

    await apply(client, { pairs: [[manual.slice(0, 8), newAcct.slice(0, 8)]], allowManual: true });

    const [a] = await db.select().from(accounts).where(eq(accounts.id, manual));
    expect(a.bankConnectionId).toBe(plaidConn);
    expect(a.externalAccountId).toBe("plaid-acc");
    const txns = await db.select().from(transactions).where(eq(transactions.accountId, manual));
    const adopted = txns.find((t) => t.externalId === "plaid-1")!;
    expect(adopted.categoryId).toBe(categoryId); // the manual row, with its category, took the Plaid identity
    expect(adopted.name).toBe("Car wash");
  });
});
