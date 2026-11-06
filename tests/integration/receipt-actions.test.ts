import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
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
let householdId: string;
let otherHousehold: string;
let txnId: string;

function form(name: string, content: string) {
  const fd = new FormData();
  fd.set("file", new File([content], name, { type: "application/octet-stream" }));
  return fd;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  root = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-actions-"));
  ({ householdId } = await insertHousehold(db));
  ({ householdId: otherHousehold } = await insertHousehold(db, "Other"));
  const { accountId } = await insertAccount(db, householdId, { name: "Card" });
  ({ transactionId: txnId } = await insertTransaction(db, householdId, accountId, {
    date: "2026-11-02",
    name: "Amazon",
    originalName: "AMAZON MKTPL",
    amount: 7539,
    normalizedAmount: -7539,
  }));
  currentHousehold = householdId;
});

afterAll(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("receipt actions", () => {
  it("files an upload under year/month named with the transaction date", async () => {
    const { uploadReceipt, fetchReceipts } = await import("../../src/actions/receipts");
    const res = await uploadReceipt(txnId, form("scan.PDF", "pdf-bytes"), db, root);
    expect("data" in res).toBe(true);

    const [row] = await db.select().from(receipts).where(eq(receipts.transactionId, txnId));
    expect(row.filePath).toBe("2026/11/2026-11-02_amazon_75.39.pdf");
    expect(row.contentType).toBe("application/pdf");
    expect((await fs.readFile(path.join(root, row.filePath))).toString()).toBe("pdf-bytes");

    const list = await fetchReceipts(txnId, db);
    expect("data" in list && list.data).toHaveLength(1);
  });

  it("rejects duplicates, bad types, empty files and unknown transactions", async () => {
    const { uploadReceipt } = await import("../../src/actions/receipts");
    expect(await uploadReceipt(txnId, form("again.pdf", "pdf-bytes"), db, root)).toEqual({
      error: "This receipt was already uploaded",
    });
    expect(await uploadReceipt(txnId, form("x.exe", "z"), db, root)).toMatchObject({
      error: expect.stringContaining("Unsupported"),
    });
    expect(await uploadReceipt(txnId, form("e.pdf", ""), db, root)).toEqual({ error: "That file is empty" });
    expect(await uploadReceipt("nope", form("n.pdf", "n"), db, root)).toEqual({
      error: "Transaction not found",
    });
  });

  it("allows several receipts per transaction and numbers same-type name collisions", async () => {
    const { uploadReceipt } = await import("../../src/actions/receipts");
    await uploadReceipt(txnId, form("card-slip.jpg", "slip"), db, root);
    await uploadReceipt(txnId, form("second.pdf", "other-pdf"), db, root);
    const rows = await db.select().from(receipts).where(eq(receipts.transactionId, txnId));
    expect(rows.map((r) => r.filePath).sort()).toEqual([
      "2026/11/2026-11-02_amazon_75.39-2.pdf",
      "2026/11/2026-11-02_amazon_75.39.jpg",
      "2026/11/2026-11-02_amazon_75.39.pdf",
    ]);
  });

  it("does not let another household delete or see a receipt", async () => {
    const { deleteReceipt, fetchReceipts } = await import("../../src/actions/receipts");
    const [row] = await db.select().from(receipts).where(eq(receipts.transactionId, txnId));
    currentHousehold = otherHousehold;
    expect(await deleteReceipt(row.id, db, root)).toEqual({ error: "Receipt not found" });
    const list = await fetchReceipts(txnId, db);
    expect("data" in list && list.data).toHaveLength(0);
    currentHousehold = householdId;
  });

  it("deletes the row and the file but leaves the transaction", async () => {
    const { deleteReceipt } = await import("../../src/actions/receipts");
    const [row] = await db.select().from(receipts).where(eq(receipts.transactionId, txnId));
    expect(await deleteReceipt(row.id, db, root)).toEqual({ success: true });
    await expect(fs.access(path.join(root, row.filePath))).rejects.toThrow();
    expect(await db.select().from(receipts).where(eq(receipts.id, row.id))).toHaveLength(0);
  });
});
