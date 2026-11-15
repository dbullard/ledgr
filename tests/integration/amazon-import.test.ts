import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";
import { insertAccount, insertCategory, insertCategoryGroup, insertHousehold, insertTransaction } from "./helpers";
import { receiptItems, receipts } from "../../src/db/schema";
import type { LedgrDb } from "../../src/db";
import {
  applyAmazonImport,
  categorizeAmazonItem,
  parseAmazonOrders,
  planAmazonImport,
} from "../../src/lib/receipts/amazon-import";
import { withHousehold } from "../../src/lib/household-context";

let db: LedgrDb;
let close: () => Promise<void>;
let root: string;
let hh: string;
let txnShip: string;
let txnOrder: string;

const HEADER =
  '﻿ASIN,"Order Date","Order ID","Order Status","Original Quantity","Product Name","Ship Date","Total Amount",Department';
const CSV = [
  HEADER,
  // order 111: two items shipped together (charge = 14.22 + 15.32 = 29.54)
  'B01,2026-10-01T10:00:00Z,111-1,Closed,1,"SMALLRIG Hot Shoe Mount, 2pcs",2026-10-02T10:00:00Z,14.22,Electronics',
  'B02,2026-10-01T10:00:00Z,111-1,Closed,2,"Elixir Strings Coated Nickel Electric Guitar Strings",2026-10-02T10:00:00Z,15.32,Misc.',
  // order 222: two shipments, charged once as the whole order (10.00 + 20.00 = 30.00)
  'B03,2026-10-05T10:00:00Z,222-2,Closed,1,"Torani Syrup, Vanilla",2026-10-06T10:00:00Z,10.00,Grocery',
  'B04,2026-10-05T10:00:00Z,222-2,Closed,1,"Mystery Gadget",2026-10-09T10:00:00Z,20.00,Not Available',
  // cancelled lines are ignored
  'B05,2026-10-07T10:00:00Z,333-3,Cancelled,1,"Never Shipped",Not Available,9.99,Misc.',
].join("\n");

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  root = await fs.mkdtemp(path.join(os.tmpdir(), "amazon-import-"));
  ({ householdId: hh } = await insertHousehold(db));
  const { accountId } = await insertAccount(db, hh, { name: "Card" });
  const { groupId } = await insertCategoryGroup(db, hh, { name: "Spending" });
  for (const name of ["Electronics", "Music Gear", "Groceries", "Home Goods"]) await insertCategory(db, hh, groupId, { name });
  const mk = async (name: string, original: string, date: string, cents: number) =>
    (await insertTransaction(db, hh, accountId, { date, name, originalName: original, amount: cents, normalizedAmount: -cents })).transactionId;
  txnShip = await mk("Amazon", "AMAZON MKTPL*AB12", "2026-10-03", 2954);
  txnOrder = await mk("Amazon", "AMZN Mktp US", "2026-10-07", 3000);
  await mk("Amazon Prime", "AMAZON PRIME*XY", "2026-10-03", 2954); // memberships are never orders
  await mk("Some Cafe", "SOME CAFE", "2026-10-03", 2954); // same amount, not Amazon
  await mk("Amazon", "AMAZON MKTPL*ZZ", "2026-10-12", 1234); // no order in the file
});

afterAll(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("categorizeAmazonItem", () => {
  it("uses keywords first, then the department, then Home Goods", () => {
    expect(categorizeAmazonItem("Elixir Strings Coated Nickel Electric Guitar Strings")).toBe("Music Gear");
    expect(categorizeAmazonItem("Mystery Gadget", "Electronics")).toBe("Electronics");
    expect(categorizeAmazonItem("Mystery Gadget")).toBe("Home Goods");
  });
});

describe("Amazon order import", () => {
  it("reads Order History.csv and skips cancelled lines", () => {
    const parsed = parseAmazonOrders(CSV);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.lines).toBe(4);
    expect(parseAmazonOrders("a,b\n1,2")).toMatchObject({ error: expect.stringContaining("Order History.csv") });
  });

  it("matches a shipment, then a whole order, only to Amazon charges", async () => {
    const parsed = parseAmazonOrders(CSV);
    if ("error" in parsed) throw new Error(parsed.error);
    const plan = await withHousehold(hh, (tx) => planAmazonImport(hh, parsed.units, tx), db);
    expect(plan.matches.map((m) => [m.unit.orderId, m.unit.items.length, m.skip]).sort()).toEqual([
      ["111-1", 2, null],
      ["222-2", 2, null],
    ]);
    expect(plan.amazonChargesWithoutOrder).toBe(1);
  });

  it("imports itemized, categorized receipts and is safe to repeat", async () => {
    const parsed = parseAmazonOrders(CSV);
    if ("error" in parsed) throw new Error(parsed.error);
    const plan = await withHousehold(hh, (tx) => planAmazonImport(hh, parsed.units, tx), db);
    expect(await applyAmazonImport(hh, plan, db, root)).toEqual({ imported: 2, skipped: 0, duplicates: 0, failed: 0, items: 4 });

    const [r] = await db.select().from(receipts).where(eq(receipts.transactionId, txnShip));
    expect(r.source).toBe("import");
    const items = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, r.id));
    expect(items.map((i) => [i.productName, i.quantityMilli, i.totalCents]).sort()).toEqual([
      ["Elixir Strings Coated Nickel Electric Guitar Strings", 2000, 1532],
      ["SMALLRIG Hot Shoe Mount", 1000, 1422],
    ]);
    const [o] = await db.select().from(receipts).where(eq(receipts.transactionId, txnOrder));
    expect(o).toBeDefined();

    const again = await withHousehold(hh, (tx) => planAmazonImport(hh, parsed.units, tx), db);
    expect(again.matches.every((m) => m.skip === "already-itemized")).toBe(true);
    expect(await applyAmazonImport(hh, again, db, root)).toMatchObject({ imported: 0, skipped: 2 });
  });
});
