import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v4 as uuid } from "uuid";
import { createTestDb } from "./setup";
import { insertHousehold, insertAccount, insertTransaction } from "./helpers";
import { getTransactions } from "../../src/queries/transactions";
import { receipts } from "../../src/db/schema";
import type { LedgrDb } from "../../src/db";

describe("getTransactions hasReceipt", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;
  let householdId: string;
  let otherHousehold: string;
  const ids: Record<string, string> = {};

  async function attach(hh: string, transactionId: string | null) {
    const id = uuid();
    await db.insert(receipts).values({
      id,
      householdId: hh,
      transactionId,
      filePath: `2026/05/${id}.txt`,
      originalFilename: "r.txt",
      contentType: "text/plain",
      sizeBytes: 1,
      sha256: id,
    });
  }

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    ({ householdId } = await insertHousehold(db));
    ({ householdId: otherHousehold } = await insertHousehold(db, "Other"));
    const { accountId } = await insertAccount(db, householdId, { name: "Card" });
    const make = async (key: string, date: string) => {
      ({ transactionId: ids[key] } = await insertTransaction(db, householdId, accountId, {
        name: key,
        date,
        amount: 1000,
        normalizedAmount: -1000,
      }));
    };
    await make("with-one", "2026-05-01");
    await make("with-two", "2026-05-02");
    await make("without", "2026-05-03");
    await make("only-waiting-receipt-elsewhere", "2026-05-04");
    await attach(householdId, ids["with-one"]);
    await attach(householdId, ids["with-two"]);
    await attach(householdId, ids["with-two"]);
    await attach(householdId, null); // waiting in the tray: belongs to no transaction
  });

  afterAll(async () => {
    await close();
  });

  it("is true only for transactions that have at least one receipt", async () => {
    const page = await getTransactions(householdId, {}, 50, null, db);
    const flag = Object.fromEntries(page.rows.map((r) => [r.name, r.hasReceipt]));
    expect(flag).toEqual({
      "with-one": true,
      "with-two": true,
      without: false,
      "only-waiting-receipt-elsewhere": false,
    });
  });

  it("does not count another household's receipt", async () => {
    // A receipt row in another household pointing at this household's transaction id must not count.
    await db.insert(receipts).values({
      id: uuid(),
      householdId: otherHousehold,
      transactionId: ids["without"],
      filePath: "x.txt",
      originalFilename: "x.txt",
      contentType: "text/plain",
      sizeBytes: 1,
      sha256: uuid(),
    });
    const page = await getTransactions(householdId, {}, 50, null, db);
    expect(page.rows.find((r) => r.name === "without")?.hasReceipt).toBe(false);
  });
});

describe("getTransactions noReceipt filter", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;
  let householdId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    ({ householdId } = await insertHousehold(db));
    const { accountId } = await insertAccount(db, householdId, { name: "Card" });
    const make = async (name: string, over: { normalizedAmount?: number; pending?: boolean; isTransfer?: boolean }) => {
      const res = await insertTransaction(db, householdId, accountId, {
        name,
        date: "2026-06-01",
        amount: 1000,
        normalizedAmount: over.normalizedAmount ?? -1000,
        pending: over.pending,
        isTransfer: over.isTransfer,
      });
      return res.transactionId;
    };
    const withReceipt = await make("has-receipt", {});
    await make("missing", {});
    await make("missing-too", {});
    await make("pending-missing", { pending: true });
    await make("income-missing", { normalizedAmount: 5000 });
    await make("transfer-missing", { isTransfer: true });
    const id = uuid();
    await db.insert(receipts).values({
      id,
      householdId,
      transactionId: withReceipt,
      filePath: `2026/06/${id}.txt`,
      originalFilename: "r.txt",
      contentType: "text/plain",
      sizeBytes: 1,
      sha256: id,
    });
  });

  afterAll(async () => {
    await close();
  });

  it("lists exactly the posted expenses that carry the no-receipt icon", async () => {
    const page = await getTransactions(householdId, { noReceipt: true }, 50, null, db);
    expect(page.rows.map((r) => r.name).sort()).toEqual(["missing", "missing-too"]);
    expect(page.rows.every((r) => r.hasReceipt === false)).toBe(true);
  });

  it("combines with other filters and leaves the list alone when off", async () => {
    const searched = await getTransactions(householdId, { noReceipt: true, search: "too" }, 50, null, db);
    expect(searched.rows.map((r) => r.name)).toEqual(["missing-too"]);
    const all = await getTransactions(householdId, {}, 50, null, db);
    expect(all.rows).toHaveLength(6);
  });
});
