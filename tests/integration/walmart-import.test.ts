import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import writeXlsxFile from "write-excel-file/node";
import { createTestDb } from "./setup";
import {
  insertAccount,
  insertCategory,
  insertCategoryGroup,
  insertHousehold,
  insertTransaction,
} from "./helpers";
import { receiptItems, receipts } from "../../src/db/schema";
import type { LedgrDb } from "../../src/db";
import {
  applyWalmartImport,
  categorizeWalmartItem,
  parseWalmartWorkbook,
  planWalmartImport,
} from "../../src/lib/receipts/walmart-import";
import { withHousehold } from "../../src/lib/household-context";

let db: LedgrDb;
let close: () => Promise<void>;
let root: string;
let hh: string;
let txnA: string;

const c = (value: string | number) => ({ value });

async function workbook(): Promise<Buffer> {
  const buf = await writeXlsxFile([
    {
      sheet: "Orders",
      data: [
        ["Order Number", "Order Date", "Order Total", "Tax"].map(c),
        [c("1001"), c("Oct 27, 2026 purchase"), c(64.8), c(2.1)],
        [c("1002"), c("Oct 20, 2026"), c(30.25), c(1)],
        [c("1003"), c("Oct 10, 2026"), c(99.99), c(4)],
      ],
    },
    {
      sheet: "Items",
      data: [
        ["Order Number", "Order Date", "Product Name", "Qty", "Price"].map(c),
        [c("1001"), c("Oct 27, 2026 purchase"), c("Great Value Bananas, 3 lb"), c(1), c(1.38)],
        [c("1001"), c("Oct 27, 2026 purchase"), c("Dawn Dish Soap, Fresh Scent"), c(1), c(3.99)],
        [c("1001"), c("Oct 27, 2026 purchase"), c("Reg Gasoline Unleaded"), c(5.5), c(59.43)],
        [c("1002"), c("Oct 20, 2026"), c("Whole Milk, 1 gal"), c(2), c(30.25)],
        [c("1003"), c("Oct 10, 2026"), c("Mystery Item"), c(1), c(99.99)],
      ],
    },
  ]).toBuffer();
  return Buffer.from(buf);
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  root = await fs.mkdtemp(path.join(os.tmpdir(), "walmart-import-"));
  ({ householdId: hh } = await insertHousehold(db));
  const { accountId } = await insertAccount(db, hh, { name: "Card" });
  const { groupId } = await insertCategoryGroup(db, hh, { name: "Spending" });
  for (const name of ["Groceries", "Personal Care", "Gas"]) await insertCategory(db, hh, groupId, { name });
  const mk = async (name: string, original: string, date: string, cents: number) =>
    (await insertTransaction(db, hh, accountId, { date, name, originalName: original, amount: cents, normalizedAmount: -cents })).transactionId;
  txnA = await mk("Walmart", "WAL-MART #1234", "2026-10-28", 6480); // order 1001, a day later
  await mk("Walmart", "WM SUPERCENTER #5", "2026-10-22", 3025); // order 1002, two days later
  await mk("Walmart", "WALMART #9", "2026-10-15", 1234); // a charge with no order in the file
  await mk("Some Cafe", "SOME CAFE", "2026-10-10", 9999); // same amount as order 1003 but not Walmart
});

afterAll(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("categorizeWalmartItem", () => {
  it("uses the keyword rules, defaulting to Groceries", () => {
    expect(categorizeWalmartItem("Reg Gasoline Unleaded")).toBe("Gas");
    expect(categorizeWalmartItem("Dawn Dish Soap")).toBe("Personal Care");
    expect(categorizeWalmartItem("Great Value Bananas")).toBe("Groceries");
  });
});

describe("Walmart order import", () => {
  it("reads the Orders and Items sheets", async () => {
    const parsed = await parseWalmartWorkbook(await workbook());
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.orders.map((o) => [o.orderNumber, o.date, o.totalCents, o.items.length])).toEqual([
      ["1001", "2026-10-27", 6480, 3],
      ["1002", "2026-10-20", 3025, 1],
      ["1003", "2026-10-10", 9999, 1],
    ]);
    expect(await parseWalmartWorkbook(Buffer.from("not a spreadsheet"))).toEqual({
      error: "That doesn't look like an .xlsx file",
    });
  });

  it("matches by amount and date, only to Walmart charges", async () => {
    const parsed = await parseWalmartWorkbook(await workbook());
    if ("error" in parsed) throw new Error(parsed.error);
    const plan = await withHousehold(hh, (tx) => planWalmartImport(hh, parsed.orders, tx), db);
    expect(plan.matches.map((m) => [m.order.orderNumber, m.daysApart, m.skip])).toEqual([
      ["1002", 2, null],
      ["1001", 1, null],
    ]);
    expect(plan.unmatchedOrders).toBe(1);
    expect(plan.walmartChargesWithoutOrder).toBe(1);
  });

  it("imports itemized receipts, filed and categorized, and is safe to repeat", async () => {
    const parsed = await parseWalmartWorkbook(await workbook());
    if ("error" in parsed) throw new Error(parsed.error);
    const plan = await withHousehold(hh, (tx) => planWalmartImport(hh, parsed.orders, tx), db);
    expect(await applyWalmartImport(hh, plan, db, root)).toEqual({ imported: 2, skipped: 0, duplicates: 0, failed: 0, items: 4 });

    const [r] = await db.select().from(receipts).where(eq(receipts.transactionId, txnA));
    expect(r.source).toBe("import");
    expect(r.filePath).toBe("2026/10/2026-10-28_walmart_64.80.txt");
    expect(await fs.readFile(path.join(root, r.filePath), "utf8")).toContain("Great Value Bananas");

    const items = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, r.id));
    expect(items.map((i) => [i.productName, i.quantityMilli, i.totalCents]).sort()).toEqual([
      ["Dawn Dish Soap", 1000, 399],
      ["Great Value Bananas", 1000, 138],
      ["Reg Gasoline Unleaded", 5500, 5943],
    ]);

    const again = await withHousehold(hh, (tx) => planWalmartImport(hh, parsed.orders, tx), db);
    expect(again.matches.every((m) => m.skip === "already-itemized")).toBe(true);
    expect(await applyWalmartImport(hh, again, db, root)).toMatchObject({ imported: 0, skipped: 2 });
  });
});
