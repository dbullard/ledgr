import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, isNull } from "drizzle-orm";
import { createTestDb } from "./setup";
import { insertAccount, insertHousehold, insertTransaction } from "./helpers";
import { receipts } from "../../src/db/schema";
import type { LedgrDb } from "../../src/db";

let currentHousehold = "";
vi.mock("../../src/lib/auth/authorize-action", () => ({
  authorizeAction: async () => ({ householdId: currentHousehold, userId: "u1" }),
}));
vi.mock("../../src/lib/auth/session", () => ({
  getHouseholdId: async () => currentHousehold,
  getSession: async () => ({ user: { id: "u1" } }),
}));

let db: LedgrDb;
let close: () => Promise<void>;
let root: string;
let accountId: string;

const file = (name: string, content: string) => {
  const fd = new FormData();
  fd.set("file", new File([content], name));
  return fd;
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  root = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-rematch-"));
  const { householdId } = await insertHousehold(db);
  currentHousehold = householdId;
  ({ accountId } = await insertAccount(db, householdId, { name: "Card" }));
});

afterAll(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("rematchWaitingReceipts", () => {
  it("attaches a waiting receipt once its transaction syncs, and leaves ambiguous ones", async () => {
    const { uploadUnmatchedReceipt } = await import("../../src/actions/receipts");
    const { rematchWaitingReceipts } = await import("../../src/lib/receipts/rematch");

    // Receipt arrives before the bank has posted the charge.
    expect(await uploadUnmatchedReceipt(file("a.txt", "Date: 2026-11-03\nTotal: $42.10"), db, root)).toEqual({ status: "unmatched" });
    expect(await rematchWaitingReceipts(currentHousehold, db, root)).toBe(0);

    // The transaction syncs.
    const { transactionId } = await insertTransaction(db, currentHousehold, accountId, {
      date: "2026-11-03",
      name: "Trader Joes",
      originalName: "TRADER JOES",
      amount: 4210,
      normalizedAmount: -4210,
    });
    expect(await rematchWaitingReceipts(currentHousehold, db, root)).toBe(1);
    const [row] = await db.select().from(receipts).where(eq(receipts.transactionId, transactionId));
    expect(row.hintTotalCents).toBe(4210);
    expect(await db.select().from(receipts).where(isNull(receipts.transactionId))).toHaveLength(0);
  });

  it("does not attach when two transactions fit equally", async () => {
    const { uploadUnmatchedReceipt } = await import("../../src/actions/receipts");
    const { rematchWaitingReceipts } = await import("../../src/lib/receipts/rematch");
    expect(await uploadUnmatchedReceipt(file("b.txt", "Date: 2026-11-05\nTotal: $9.99"), db, root)).toEqual({ status: "unmatched" });
    for (const name of ["Shop A", "Shop B"]) {
      await insertTransaction(db, currentHousehold, accountId, {
        date: "2026-11-05", name, originalName: name.toUpperCase(), amount: 999, normalizedAmount: -999,
      });
    }
    expect(await rematchWaitingReceipts(currentHousehold, db, root)).toBe(0);
    expect(await db.select().from(receipts).where(isNull(receipts.transactionId))).toHaveLength(1);
  });
});
