import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";
import { server } from "../mocks/server";
import { transactions } from "@/db/schema";
import { syncConnection } from "@/lib/simplefin/sync";
import { findDuplicates } from "@/lib/import/dedup";
import { insertHousehold, insertSimplefinConnection, insertAccount, insertTransaction } from "./helpers";
import type { LedgrDb } from "@/db";
import type { NormalizedRow } from "@/lib/import/normalize";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "203.0.113.10", family: 4 }]),
}));

beforeAll(() => {
  vi.stubEnv("ENCRYPTION_KEY", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2");
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
});

const dayStr = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const epoch = (offset: number) => Math.floor((Date.now() + offset * 86_400_000) / 1000);

describe("file import and SimpleFIN sync do not duplicate each other", () => {
  let db: LedgrDb;
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    server.resetHandlers();
    await close?.();
    close = undefined;
  });

  async function setup() {
    ({ db, close } = await createTestDb());
    const { householdId } = await insertHousehold(db);
    const { connectionId } = await insertSimplefinConnection(db, householdId);
    const { accountId } = await insertAccount(db, householdId, {
      bankConnectionId: connectionId, externalAccountId: "sf-acc-checking", type: "checking",
    });
    return { householdId, connectionId, accountId };
  }

  it("import skips rows the bank sync already has, even with a different description and date", async () => {
    const { householdId, accountId } = await setup();
    await insertTransaction(db, householdId, accountId, {
      externalId: "sf-1", provider: "simplefin", date: dayStr(-5), amount: -4250, normalizedAmount: -4250,
      originalName: "COFFEE SHOP PURCHASE 0123",
    });
    const incoming: NormalizedRow[] = [
      // same purchase, bank's wording, posted a day later
      { id: "i1", accountId, householdId, date: dayStr(-4), originalName: "POS DEBIT COFFEE SHOP", name: "x", amount: -4250, externalId: "FIT-1" },
      // genuinely new
      { id: "i2", accountId, householdId, date: dayStr(-4), originalName: "HARDWARE", name: "x", amount: -9900, externalId: "FIT-2" },
    ];
    const { unique, duplicates } = await findDuplicates(incoming, accountId, db);
    expect(duplicates.map((r) => r.id)).toEqual(["i1"]);
    expect(unique.map((r) => r.id)).toEqual(["i2"]);
  });

  it("sync adopts an imported row instead of inserting a duplicate, keeping its category and name", async () => {
    const { householdId, connectionId, accountId } = await setup();
    const { transactionId } = await insertTransaction(db, householdId, accountId, {
      externalId: "FIT-1", provider: null, date: dayStr(-3), amount: -4250, normalizedAmount: -4250,
      originalName: "POS DEBIT COFFEE SHOP", name: "My coffee",
    }) as { transactionId: string };

    server.use(
      http.get("https://bridge.simplefin.test/simplefin/accounts", () =>
        HttpResponse.json({
          accounts: [{
            id: "sf-acc-checking", name: "Checking", currency: "USD", balance: "100.00",
            "balance-date": epoch(0),
            transactions: [{ id: "sf-txn-1", posted: epoch(-2), amount: "-42.50", description: "COFFEE SHOP PURCHASE 0123" }],
          }],
        }),
      ),
    );

    const result = await syncConnection(connectionId, householdId, db);
    expect(result.success).toBe(true);

    const rows = await db.select().from(transactions).where(eq(transactions.accountId, accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(transactionId);
    expect(rows[0].externalId).toBe("sf-txn-1");
    expect(rows[0].provider).toBe("simplefin");
    expect(rows[0].name).toBe("My coffee");
  });
});
