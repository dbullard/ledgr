import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { createTestDb } from "./setup";
import { insertAccount, insertCategory, insertCategoryGroup, insertHousehold, insertTransaction } from "./helpers";
import { receiptItems, receipts } from "../../src/db/schema";
import type { LedgrDb } from "../../src/db";
import { getItemSpendByCategory, getProductPriceHistory, getTopProducts } from "../../src/queries/receipt-items";

let db: LedgrDb;
let close: () => Promise<void>;
let householdId: string;
let otherHousehold: string;
let grocId: string;
let homeId: string;

async function addReceipt(
  hid: string,
  txnId: string | null,
  items: { raw: string; product?: string; cat?: string; cents: number; qty?: number }[],
) {
  const id = uuid();
  await db.insert(receipts).values({
    id,
    householdId: hid,
    transactionId: txnId,
    filePath: `x/${id}.txt`,
    originalFilename: "r.txt",
    contentType: "text/plain",
    sizeBytes: 1,
    sha256: id,
  });
  await db.insert(receiptItems).values(
    items.map((it, i) => ({
      id: uuid(),
      householdId: hid,
      receiptId: id,
      lineNo: i + 1,
      rawName: it.raw,
      productName: it.product ?? null,
      categoryId: it.cat ?? null,
      quantityMilli: it.qty ?? 1000,
      totalCents: it.cents,
    })),
  );
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ({ householdId } = await insertHousehold(db));
  ({ householdId: otherHousehold } = await insertHousehold(db, "Other"));
  const { accountId } = await insertAccount(db, householdId, { name: "Card" });
  const { accountId: otherAcct } = await insertAccount(db, otherHousehold, { name: "Card" });
  const { groupId } = await insertCategoryGroup(db, householdId, { name: "Spending" });
  ({ categoryId: grocId } = await insertCategory(db, householdId, groupId, { name: "Groceries" }));
  ({ categoryId: homeId } = await insertCategory(db, householdId, groupId, { name: "Home Goods" }));

  const mk = async (hid: string, acct: string, date: string, cents: number, name = "Walmart") =>
    (await insertTransaction(db, hid, acct, { date, name, originalName: name, amount: cents, normalizedAmount: -cents })).transactionId;

  const t1 = await mk(householdId, accountId, "2026-09-05", 1000);
  const t2 = await mk(householdId, accountId, "2026-10-05", 1200, "Kroger");
  const t3 = await mk(householdId, accountId, "2026-10-20", 500);
  await addReceipt(householdId, t1, [
    { raw: "KS ORG BNNA", product: "Bananas", cat: grocId, cents: 300, qty: 3000 },
    { raw: "SOAP", cat: homeId, cents: 500 },
  ]);
  await addReceipt(householdId, t2, [
    { raw: "BANANAS ORG", product: "bananas", cat: grocId, cents: 400, qty: 2000 },
    { raw: "MYSTERY", cents: 100 },
  ]);
  await addReceipt(householdId, null, [{ raw: "UNATTACHED", product: "Bananas", cat: grocId, cents: 9999 }]);
  await addReceipt(householdId, t3, [{ raw: "OLD", cat: grocId, cents: 50 }]);
  const o = await mk(otherHousehold, otherAcct, "2026-10-05", 700);
  await addReceipt(otherHousehold, o, [{ raw: "THEIRS", product: "Bananas", cat: grocId, cents: 777 }]);
});

afterAll(async () => {
  await close();
});

const range = { dateFrom: "2026-09-01", dateTo: "2026-10-10" };

describe("receipt item reports", () => {
  it("totals by category, counting only attached receipts in range and this household", async () => {
    const rows = await getItemSpendByCategory(householdId, range, db);
    expect(rows.map((r) => [r.categoryName, r.totalCents, r.itemCount])).toEqual([
      ["Groceries", 700, 2],
      ["Home Goods", 500, 1],
      [null, 100, 1],
    ]);
  });

  it("ranks products case-insensitively with average price per unit", async () => {
    const rows = await getTopProducts(householdId, range, 10, db);
    const bananas = rows.find((r) => r.key === "bananas")!;
    expect(bananas).toMatchObject({ totalCents: 700, purchases: 2, lastDate: "2026-10-05" });
    expect(bananas.avgUnitCents).toBe(140); // 700 cents over 5 units
    expect(rows[0].key).toBe("bananas");
  });

  it("filters to one category", async () => {
    const rows = await getTopProducts(householdId, { ...range, categoryId: homeId }, 10, db);
    expect(rows.map((r) => r.key)).toEqual(["soap"]);
  });

  it("gives a per-unit price history, oldest first", async () => {
    const h = await getProductPriceHistory(householdId, "Bananas", db);
    expect(h.map((p) => [p.date, p.merchant, p.unitCents])).toEqual([
      ["2026-09-05", "Walmart", 100],
      ["2026-10-05", "Kroger", 200],
    ]);
  });
});
