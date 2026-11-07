import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "./setup";
import { insertAccount, insertCategory, insertCategoryGroup, insertHousehold, insertTransaction } from "./helpers";
import { receiptItems, receipts, transactionSplits } from "../../src/db/schema";
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
let catId: string;

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
  const { groupId } = await insertCategoryGroup(db, householdId, { name: "Spending" });
  ({ categoryId: catId } = await insertCategory(db, householdId, groupId, { name: "Groceries" }));
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

  it("detaches a receipt back to the waiting list without deleting it", async () => {
    const { uploadReceipt, detachReceipt, fetchReceipts } = await import("../../src/actions/receipts");
    const up = await uploadReceipt(txnId, form("keep.txt", "TOTAL 75.39"), db, root);
    expect("data" in up).toBe(true);
    const [row] = await db.select().from(receipts).where(and(eq(receipts.transactionId, txnId), eq(receipts.originalFilename, "keep.txt")));
    await db.insert(transactionSplits).values({ id: "split-a", transactionId: txnId, categoryId: catId, amount: 7539, notes: "From receipt items" });
    await db.insert(transactionSplits).values({ id: "split-b", transactionId: txnId, categoryId: catId, amount: 1, notes: "mine" });

    expect(await detachReceipt(row.id, db)).toEqual({ success: true });

    const [after] = await db.select().from(receipts).where(eq(receipts.id, row.id));
    expect(after.transactionId).toBeNull();
    expect(after.autoMatchBlocked).toBe(true);
    await expect(fs.access(path.join(root, after.filePath))).resolves.toBeUndefined();
    const splits = await db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, txnId));
    expect(splits.map((x) => x.id)).toEqual(["split-b"]); // only the receipt-made split goes
    const list = await fetchReceipts(txnId, db);
    expect("data" in list && list.data.map((r) => r.id)).not.toContain(row.id);

    expect(await detachReceipt(row.id, db)).toEqual({ error: "This receipt isn't attached to a transaction" });
    currentHousehold = otherHousehold;
    expect(await detachReceipt(row.id, db)).toEqual({ error: "Receipt not found" });
    currentHousehold = householdId;
    await db.delete(receipts).where(eq(receipts.id, row.id));
  });

  it("builds the item list from the receipt itself, again after a delete and re-upload", async () => {
    const { uploadReceipt, deleteReceipt } = await import("../../src/actions/receipts");
    const body = [
      "Delivery from club items(2)",
      "Bananas, 3 lbs. Qty 1 $1.56",
      "Member's Mark Seasoned Beef Bites with Garlic and Herb Compound Butter,",
      "1.5 lbs.",
      "Qty 2 $37.76",
      "Subtotal $39.32",
    ].join("\n");
    for (let round = 0; round < 2; round++) {
      const up = await uploadReceipt(txnId, form("order.txt", body), db, root);
      expect("data" in up).toBe(true);
      const [row] = await db.select().from(receipts).where(and(eq(receipts.transactionId, txnId), eq(receipts.originalFilename, "order.txt")));
      const items = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, row.id));
      expect(items.map((i) => [i.productName, i.totalCents, i.quantityMilli, i.categoryId])).toEqual([
        ["Bananas", 156, 1000, catId],
        ["Member's Mark Seasoned Beef Bites with Garlic and Herb Compound Butter", 3776, 2000, catId],
      ]);
      expect(row.parsedAt).not.toBeNull();
      expect(await deleteReceipt(row.id, db, root)).toEqual({ success: true }); // then the same file goes in again
    }
  });

  it("itemizes a restaurant receipt that adds up to its subtotal, using the transaction's category", async () => {
    const { uploadReceipt } = await import("../../src/actions/receipts");
    const { accountId } = await insertAccount(db, householdId, { name: "Dining card" });
    const { groupId } = await insertCategoryGroup(db, householdId, { name: "Food" });
    const { categoryId: dining } = await insertCategory(db, householdId, groupId, { name: "Restaurants" });
    const { transactionId: dinner } = await insertTransaction(db, householdId, accountId, {
      date: "2026-11-05", name: "Big Orange", originalName: "BIG ORANGE", amount: 5254, normalizedAmount: -5254, categoryId: dining,
    });
    const body = "BIG ORANGE\nAmerican Classic Burger $13.75\nGluten Free Bun\nSouthern Fried Chicken\nSandwich $20.50\nSubtotal $34.25\nTax $3.92\nTotal $38.17";
    expect("data" in (await uploadReceipt(dinner, form("toast.txt", body), db, root))).toBe(true);
    const [row] = await db.select().from(receipts).where(eq(receipts.transactionId, dinner));
    const items = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, row.id));
    expect(items.map((i) => [i.rawName, i.totalCents, i.categoryId])).toEqual([
      ["American Classic Burger", 1375, dining],
      ["Southern Fried Chicken Sandwich", 2050, dining],
    ]);
  });
});
