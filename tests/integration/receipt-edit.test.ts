import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { createTestDb } from "./setup";
import {
  insertAccount,
  insertCategory,
  insertCategoryGroup,
  insertHousehold,
  insertTransaction,
} from "./helpers";
import { productAliases, receiptItems, receipts } from "../../src/db/schema";
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
let householdId: string;
let otherHousehold: string;
let txnId: string;
let grocId: string;
let homeId: string;
let otherCatId: string;

async function makeReceipt(opts: {
  household?: string;
  transactionId?: string | null;
  hintTotalCents?: number | null;
  autoMatchBlocked?: boolean;
  items?: { rawName: string; productName?: string | null; categoryId?: string | null; quantityMilli?: number; totalCents: number }[];
}) {
  const hh = opts.household ?? householdId;
  const id = uuid();
  await db.insert(receipts).values({
    id,
    householdId: hh,
    transactionId: opts.transactionId === undefined ? txnId : opts.transactionId,
    filePath: `2026/11/${id}.txt`,
    originalFilename: "r.txt",
    contentType: "text/plain",
    sizeBytes: 10,
    sha256: id,
    hintTotalCents: opts.hintTotalCents ?? null,
    hintDate: "2026-11-02",
    hintMerchant: "Walmart",
    autoMatchBlocked: opts.autoMatchBlocked ?? false,
    parsedAt: opts.items?.length ? new Date() : null,
  });
  const ids: string[] = [];
  for (const [i, it] of (opts.items ?? []).entries()) {
    const itemId = uuid();
    ids.push(itemId);
    await db.insert(receiptItems).values({
      id: itemId,
      householdId: hh,
      receiptId: id,
      lineNo: i + 1,
      rawName: it.rawName,
      productName: it.productName ?? null,
      categoryId: it.categoryId ?? null,
      quantityMilli: it.quantityMilli ?? 1000,
      totalCents: it.totalCents,
    });
  }
  return { id, itemIds: ids };
}

const rowsOf = (receiptId: string) =>
  db.select().from(receiptItems).where(eq(receiptItems.receiptId, receiptId)).orderBy(asc(receiptItems.lineNo));
const receiptRow = async (id: string) => (await db.select().from(receipts).where(eq(receipts.id, id)))[0];
const aliases = () => db.select().from(productAliases).where(eq(productAliases.householdId, householdId));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ({ householdId } = await insertHousehold(db));
  ({ householdId: otherHousehold } = await insertHousehold(db, "Other"));
  const { accountId } = await insertAccount(db, householdId, { name: "Card" });
  ({ transactionId: txnId } = await insertTransaction(db, householdId, accountId, {
    date: "2026-11-02",
    name: "Walmart",
    originalName: "WALMART",
    amount: 1500,
    normalizedAmount: -1500,
  }));
  const { groupId } = await insertCategoryGroup(db, householdId, { name: "Spending" });
  ({ categoryId: grocId } = await insertCategory(db, householdId, groupId, { name: "Groceries" }));
  ({ categoryId: homeId } = await insertCategory(db, householdId, groupId, { name: "Home Goods" }));
  const { groupId: otherGroup } = await insertCategoryGroup(db, otherHousehold, { name: "Spending" });
  ({ categoryId: otherCatId } = await insertCategory(db, otherHousehold, otherGroup, { name: "Theirs" }));
  currentHousehold = householdId;
});

beforeEach(async () => {
  await db.delete(productAliases).where(eq(productAliases.householdId, householdId));
});

afterAll(async () => {
  await close();
});

describe("saveReceiptEdits", () => {
  it("edits total, date and merchant without moving the receipt", async () => {
    const { saveReceiptEdits } = await import("../../src/actions/receipt-edit");
    const r = await makeReceipt({ hintTotalCents: 999, autoMatchBlocked: true });
    const res = await saveReceiptEdits(r.id, { totalCents: 1500, date: "2026-11-03", merchant: "Walmart Supercenter", items: [] }, db);
    expect(res).toMatchObject({ data: { totalCents: 1500, date: "2026-11-03", merchant: "Walmart Supercenter" } });
    const row = await receiptRow(r.id);
    expect(row).toMatchObject({
      hintTotalCents: 1500,
      hintDate: "2026-11-03",
      hintMerchant: "Walmart Supercenter",
      transactionId: txnId,
      autoMatchBlocked: true,
    });
  });

  it("leaves a field unchanged when omitted and clears it when null", async () => {
    const { saveReceiptEdits } = await import("../../src/actions/receipt-edit");
    const r = await makeReceipt({ hintTotalCents: 999 });
    await saveReceiptEdits(r.id, { merchant: null, items: [] }, db);
    expect(await receiptRow(r.id)).toMatchObject({ hintTotalCents: 999, hintDate: "2026-11-02", hintMerchant: null });
  });

  it("edits price and quantity of an existing line and keeps its id", async () => {
    const { saveReceiptEdits } = await import("../../src/actions/receipt-edit");
    const r = await makeReceipt({ items: [{ rawName: "MILK 1GAL", totalCents: 399 }] });
    const res = await saveReceiptEdits(
      r.id,
      { items: [{ id: r.itemIds[0], rawName: "MILK 1GAL", quantityMilli: 2000, totalCents: 450 }] },
      db,
    );
    expect("data" in res).toBe(true);
    const rows = await rowsOf(r.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: r.itemIds[0], quantityMilli: 2000, totalCents: 450 });
  });

  it("adds a new line, deletes an omitted line, and renumbers lineNo from 1", async () => {
    const { saveReceiptEdits } = await import("../../src/actions/receipt-edit");
    const r = await makeReceipt({
      items: [
        { rawName: "A", totalCents: 100 },
        { rawName: "B", totalCents: 200 },
        { rawName: "C", totalCents: 300 },
      ],
    });
    await saveReceiptEdits(
      r.id,
      {
        items: [
          { rawName: "NEW", quantityMilli: 1000, totalCents: 50 },
          { id: r.itemIds[2], rawName: "C", quantityMilli: 1000, totalCents: 300 },
        ],
      },
      db,
    );
    const rows = await rowsOf(r.id);
    expect(rows.map((x) => [x.lineNo, x.rawName])).toEqual([
      [1, "NEW"],
      [2, "C"],
    ]);
    expect(rows[1].id).toBe(r.itemIds[2]);
  });

  it("keeps a manually typed productName instead of the learned alias", async () => {
    const { saveReceiptEdits } = await import("../../src/actions/receipt-edit");
    await db.insert(productAliases).values({
      id: uuid(),
      householdId,
      rawKey: "ks org bnna",
      productName: "Learned Banana",
      categoryId: null,
    });
    const r = await makeReceipt({ items: [{ rawName: "KS ORG BNNA", totalCents: 349 }] });
    await saveReceiptEdits(
      r.id,
      { items: [{ id: r.itemIds[0], rawName: "KS ORG BNNA", productName: "Typed Banana", quantityMilli: 1000, totalCents: 349 }] },
      db,
    );
    expect((await rowsOf(r.id))[0].productName).toBe("Typed Banana");
  });

  it("a price, quantity or printed-name edit writes no productAliases row", async () => {
    const { saveReceiptEdits } = await import("../../src/actions/receipt-edit");
    const r = await makeReceipt({ items: [{ rawName: "MILK 1GAL", productName: "Milk", totalCents: 399 }] });
    await saveReceiptEdits(
      r.id,
      { items: [{ id: r.itemIds[0], rawName: "MILK 1 GALLON", productName: "Milk", quantityMilli: 2000, totalCents: 450 }] },
      db,
    );
    expect(await aliases()).toHaveLength(0);
  });

  it("a changed productName or category upserts one productAliases row", async () => {
    const { saveReceiptEdits } = await import("../../src/actions/receipt-edit");
    const r = await makeReceipt({ items: [{ rawName: "MILK 1GAL", productName: "Milk", categoryId: grocId, totalCents: 399 }] });
    await saveReceiptEdits(
      r.id,
      { items: [{ id: r.itemIds[0], rawName: "MILK 1GAL", productName: "Whole Milk", categoryId: homeId, quantityMilli: 1000, totalCents: 399 }] },
      db,
    );
    const rows = await aliases();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rawKey: "milk 1gal", productName: "Whole Milk", categoryId: homeId });
  });

  it("rejects an item id from another receipt or household and changes nothing", async () => {
    const { saveReceiptEdits } = await import("../../src/actions/receipt-edit");
    const mine = await makeReceipt({ hintTotalCents: 100, items: [{ rawName: "MINE", totalCents: 100 }] });
    const sameHouseholdOther = await makeReceipt({ items: [{ rawName: "OTHER", totalCents: 5 }] });
    const foreign = await makeReceipt({ household: otherHousehold, transactionId: null, items: [{ rawName: "THEIRS", totalCents: 7 }] });
    for (const badId of [sameHouseholdOther.itemIds[0], foreign.itemIds[0], uuid()]) {
      const res = await saveReceiptEdits(
        mine.id,
        { totalCents: 999, items: [{ id: badId, rawName: "HIJACK", quantityMilli: 1000, totalCents: 1 }] },
        db,
      );
      expect(res).toEqual({ error: expect.any(String) });
    }
    expect((await rowsOf(mine.id)).map((x) => x.rawName)).toEqual(["MINE"]);
    expect((await receiptRow(mine.id)).hintTotalCents).toBe(100);
    expect((await rowsOf(sameHouseholdOther.id))[0].rawName).toBe("OTHER");
    expect((await db.select().from(receiptItems).where(and(eq(receiptItems.id, foreign.itemIds[0]))))[0].rawName).toBe("THEIRS");
  });

  it("zero items clears all lines and sets parsedAt to null", async () => {
    const { saveReceiptEdits } = await import("../../src/actions/receipt-edit");
    const r = await makeReceipt({ items: [{ rawName: "A", totalCents: 100 }] });
    const res = await saveReceiptEdits(r.id, { items: [] }, db);
    expect(res).toMatchObject({ data: { items: [], itemsTotalCents: 0 } });
    expect(await rowsOf(r.id)).toHaveLength(0);
    const row = await receiptRow(r.id);
    expect(row.parsedAt).toBeNull();
    expect(row.transactionId).toBe(txnId);
  });

  it("with the total cleared, the gap falls back to the transaction amount", async () => {
    const { saveReceiptEdits } = await import("../../src/actions/receipt-edit");
    const r = await makeReceipt({ hintTotalCents: 900, items: [{ rawName: "A", totalCents: 1000 }] });
    const res = await saveReceiptEdits(
      r.id,
      { totalCents: null, items: [{ id: r.itemIds[0], rawName: "A", quantityMilli: 1000, totalCents: 1000 }] },
      db,
    );
    expect(res).toMatchObject({ data: { totalCents: null, itemsTotalCents: 1000, gapCents: 500 } });
  });

  it("edits a receipt that has no transaction", async () => {
    const { saveReceiptEdits, fetchReceiptForEdit } = await import("../../src/actions/receipt-edit");
    const r = await makeReceipt({ transactionId: null, hintTotalCents: 800 });
    const res = await saveReceiptEdits(
      r.id,
      { totalCents: 850, items: [{ rawName: "TACO", quantityMilli: 1000, totalCents: 850 }] },
      db,
    );
    expect(res).toMatchObject({ data: { transactionId: null, totalCents: 850, itemsTotalCents: 850, gapCents: 0 } });
    expect(await fetchReceiptForEdit(r.id, db)).toMatchObject({ data: { receiptId: r.id } });
  });

  it("rejects duplicate ids, quantity 0, 201 lines, an impossible date and a foreign category, writing nothing", async () => {
    const { saveReceiptEdits } = await import("../../src/actions/receipt-edit");
    const r = await makeReceipt({ hintTotalCents: 100, items: [{ rawName: "A", totalCents: 100 }] });
    const one = (over: object = {}) => ({ id: r.itemIds[0], rawName: "A", quantityMilli: 1000, totalCents: 100, ...over });
    const bad: unknown[] = [
      { items: [one(), one()] },
      { items: [one({ quantityMilli: 0 })] },
      { items: Array.from({ length: 201 }, (_, i) => ({ rawName: `L${i}`, quantityMilli: 1000, totalCents: 1 })) },
      { date: "2026-02-30", items: [one()] },
      { items: [one({ categoryId: otherCatId })] },
      { totalCents: 1.5, items: [one()] },
    ];
    for (const edits of bad) {
      expect(await saveReceiptEdits(r.id, edits, db)).toEqual({ error: expect.any(String) });
    }
    expect((await rowsOf(r.id)).map((x) => x.rawName)).toEqual(["A"]);
    expect((await receiptRow(r.id)).hintTotalCents).toBe(100);
  });

  it("returns the refreshed data with itemsTotalCents and gapCents", async () => {
    const { saveReceiptEdits, fetchReceiptForEdit } = await import("../../src/actions/receipt-edit");
    const r = await makeReceipt({ hintTotalCents: 1500 });
    const res = await saveReceiptEdits(
      r.id,
      {
        totalCents: 1500,
        items: [
          { rawName: "A", productName: "Apple", categoryId: grocId, quantityMilli: 1500, totalCents: 1000 },
          { rawName: "DISC", quantityMilli: 1000, totalCents: -100 },
        ],
      },
      db,
    );
    expect(res).toMatchObject({
      data: {
        itemsTotalCents: 900,
        gapCents: 600,
        items: [
          { lineNo: 1, rawName: "A", productName: "Apple", categoryId: grocId, categoryName: "Groceries", quantityMilli: 1500, totalCents: 1000 },
          { lineNo: 2, rawName: "DISC", totalCents: -100 },
        ],
      },
    });
    expect(await fetchReceiptForEdit(r.id, db)).toEqual(res);
  });

  it("does not see another household's receipt", async () => {
    const { saveReceiptEdits, fetchReceiptForEdit } = await import("../../src/actions/receipt-edit");
    const foreign = await makeReceipt({ household: otherHousehold, transactionId: null });
    expect(await fetchReceiptForEdit(foreign.id, db)).toEqual({ error: "Receipt not found" });
    expect(await saveReceiptEdits(foreign.id, { items: [] }, db)).toEqual({ error: "Receipt not found" });
  });

  it("a corrected total on a waiting receipt survives the tray's re-read of the file", async () => {
    const { saveReceiptEdits } = await import("../../src/actions/receipt-edit");
    const { uploadUnmatchedReceipt } = await import("../../src/actions/receipts");
    const { rematchWaitingReceipts } = await import("../../src/lib/receipts/rematch");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-edit-"));
    try {
      const fd = new FormData();
      fd.set("file", new File(["Date: 2026-03-03\nTotal: $77.77"], "lonely.txt"));
      expect(await uploadUnmatchedReceipt(fd, db, root)).toEqual({ status: "unmatched" });
      const [row] = await db.select().from(receipts).where(eq(receipts.originalFilename, "lonely.txt"));
      expect(row.hintTotalCents).toBe(7777);

      await saveReceiptEdits(row.id, { totalCents: 8888, items: [] }, db);
      await rematchWaitingReceipts(householdId, db, root);
      expect((await receiptRow(row.id)).hintTotalCents).toBe(8888);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
