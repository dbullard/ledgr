import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";
import {
  insertAccount,
  insertCategory,
  insertCategoryGroup,
  insertHousehold,
  insertTransaction,
} from "./helpers";
import { receiptItems, receipts, transactionSplits } from "../../src/db/schema";
import type { LedgrDb } from "../../src/db";
import type { ParseRunner } from "../../src/lib/receipts/parse-model";

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
let receiptId: string;
let txnId: string;
let grocId: string;
let homeId: string;

const model: ParseRunner = async () => ({
  items: [
    { name: "KS ORG BNNA", totalCents: 349, product: "Banana", category: "Groceries" },
    { name: "MILK 1GAL", totalCents: 399, category: "Groceries" },
    { name: "DISH SOAP", totalCents: 499, category: "Home Goods" },
    { name: "MYSTERY", totalCents: 100 },
  ],
  totalCents: 1500,
});

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  root = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-items-"));
  const { householdId } = await insertHousehold(db);
  currentHousehold = householdId;
  const { accountId } = await insertAccount(db, householdId, { name: "Card" });
  const { groupId } = await insertCategoryGroup(db, householdId, { name: "Spending" });
  ({ categoryId: grocId } = await insertCategory(db, householdId, groupId, { name: "Groceries" }));
  ({ categoryId: homeId } = await insertCategory(db, householdId, groupId, { name: "Home Goods" }));
  ({ transactionId: txnId } = await insertTransaction(db, householdId, accountId, {
    date: "2026-11-02",
    name: "Walmart",
    originalName: "WALMART",
    amount: 1500,
    normalizedAmount: -1500,
  }));

  const { uploadReceipt } = await import("../../src/actions/receipts");
  const fd = new FormData();
  fd.set("file", new File(["Walmart receipt"], "walmart.txt"));
  const res = await uploadReceipt(txnId, fd, db, root);
  if (!("data" in res)) throw new Error("upload failed");
  receiptId = res.data.id;
});

afterAll(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("receipt items", () => {
  it("refuses to run without a local model", async () => {
    const { parseReceiptItems } = await import("../../src/actions/receipt-items");
    const res = await parseReceiptItems(receiptId, db, root, model, "Item reading needs a local model.");
    expect(res).toEqual({ error: "Item reading needs a local model." });
  });

  it("stores parsed lines with categories and a reconciliation gap", async () => {
    const { parseReceiptItems } = await import("../../src/actions/receipt-items");
    const res = await parseReceiptItems(receiptId, db, root, model, null);
    if (!("data" in res)) throw new Error(JSON.stringify(res));
    expect(res.data.items.map((i) => [i.rawName, i.productName, i.categoryName])).toEqual([
      ["KS ORG BNNA", "Banana", "Groceries"],
      ["MILK 1GAL", null, "Groceries"],
      ["DISH SOAP", null, "Home Goods"],
      ["MYSTERY", null, null],
    ]);
    expect(res.data.itemsTotalCents).toBe(1347);
    expect(res.data.gapCents).toBe(153);
  });

  it("retries once when the lines found cover far less than the receipt total", async () => {
    const { parseReceiptItems } = await import("../../src/actions/receipt-items");
    await db.update(receipts).set({ hintTotalCents: 1500 }).where(eq(receipts.id, receiptId));
    let calls = 0;
    const shortThenFull: ParseRunner = async (input) => {
      calls++;
      if (calls === 1) return { items: [{ name: "KS ORG BNNA", totalCents: 349 }] };
      return model(input);
    };
    const res = await parseReceiptItems(receiptId, db, root, shortThenFull, null);
    if (!("data" in res)) throw new Error(JSON.stringify(res));
    expect(calls).toBe(2);
    expect(res.data.items).toHaveLength(4);

    calls = 0;
    const good: ParseRunner = async (input) => {
      calls++;
      return model(input);
    };
    await parseReceiptItems(receiptId, db, root, good, null);
    expect(calls).toBe(1);
  });

  it("learns a correction and applies it on the next receipt", async () => {
    const { updateReceiptItem, parseReceiptItems, fetchReceiptItems } = await import("../../src/actions/receipt-items");
    const before = await fetchReceiptItems(receiptId, db);
    if (!("data" in before)) throw new Error("no data");
    const banana = before.data.items.find((i) => i.rawName === "KS ORG BNNA")!;
    const mystery = before.data.items.find((i) => i.rawName === "MYSTERY")!;

    expect(await updateReceiptItem(banana.id, { productName: "Bananas" }, db)).toEqual({ success: true });
    expect(await updateReceiptItem(mystery.id, { productName: "Gum", categoryId: homeId }, db)).toEqual({ success: true });
    expect(await updateReceiptItem(mystery.id, { categoryId: "nope" }, db)).toEqual({ error: "Category not found" });

    const again = await parseReceiptItems(receiptId, db, root, model, null);
    if (!("data" in again)) throw new Error("no data");
    const byRaw = Object.fromEntries(again.data.items.map((i) => [i.rawName, i]));
    expect(byRaw["KS ORG BNNA"].productName).toBe("Bananas");
    expect(byRaw["MYSTERY"]).toMatchObject({ productName: "Gum", categoryName: "Home Goods" });
  });

  it("creates splits that add up to the transaction, spreading tax", async () => {
    const { createSplitsFromReceipt } = await import("../../src/actions/receipt-items");
    expect(await createSplitsFromReceipt(receiptId, db)).toEqual({ data: { splits: 2 } });
    const splits = await db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, txnId));
    expect(splits.reduce((s, x) => s + x.amount, 0)).toBe(1500);
    const home = splits.find((s) => s.categoryId === homeId)!;
    const groc = splits.find((s) => s.categoryId === grocId)!;
    // groceries 748 vs home 599 of 1347
    expect(groc.amount).toBe(833);
    expect(home.amount).toBe(667);

    expect(await createSplitsFromReceipt(receiptId, db)).toEqual({ data: { splits: 2 } });
    expect(await db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, txnId))).toHaveLength(2);
  });

  it("deleting the receipt removes its items", async () => {
    const { deleteReceipt } = await import("../../src/actions/receipts");
    await deleteReceipt(receiptId, db, root);
    expect(await db.select().from(receiptItems).where(eq(receiptItems.receiptId, receiptId))).toHaveLength(0);
  });

  it("re-reading a receipt with printed Qty lines uses them as they are, never the model", async () => {
    const { parseReceiptItems } = await import("../../src/actions/receipt-items");
    const { uploadReceipt } = await import("../../src/actions/receipts");
    const { accountId } = await insertAccount(db, currentHousehold, { name: "Card 2" });
    const { transactionId } = await insertTransaction(db, currentHousehold, accountId, {
      date: "2026-11-06",
      name: "Walmart",
      originalName: "WALMART",
      amount: 1000,
      normalizedAmount: -1000,
    });
    const text = [
      "Delivery items(2)",
      "Great Value Chunk Chicken Breast with",
      "Rib Meat in Water, 12.5 oz Can 2 substituted Qty 2 $5.68",
      "Butter, 15 Count 23 shopped Qty 1 $14.97",
    ].join("\n");
    const fd = new FormData();
    fd.set("file", new File([text], "walmart-order.txt"));
    const up = await uploadReceipt(transactionId, fd, db, root);
    if (!("data" in up)) throw new Error("upload failed");

    const neverCalled: ParseRunner = async () => {
      throw new Error("the model should not be asked");
    };
    const res = await parseReceiptItems(up.data.id, db, root, neverCalled, "no model configured");
    if (!("data" in res)) throw new Error(JSON.stringify(res));
    expect(res.data.items.map((i) => [i.rawName, i.totalCents])).toEqual([
      ["Great Value Chunk Chicken Breast with Rib Meat in Water, 12.5 oz Can", 568],
      ["Butter, 15 Count", 1497],
    ]);
  });
});
