import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { createTestDb } from "./setup";
import { insertAccount, insertCategory, insertCategoryGroup, insertHousehold, insertTransaction } from "./helpers";
import { receiptItems, receipts } from "../../src/db/schema";
import type { LedgrDb } from "../../src/db";
import { buildGroceryResponse, resolveHouseholdId } from "../../src/lib/grocery-items";

let db: LedgrDb;
let close: () => Promise<void>;
let hid: string;
let bareHid: string; // household with no Groceries category

async function addReceipt(householdId: string, txnId: string, items: { raw: string; cat: string; cents: number; qty?: number }[]) {
  const id = uuid();
  await db.insert(receipts).values({ id, householdId, transactionId: txnId, filePath: `x/${id}.txt`, originalFilename: "r.txt", contentType: "text/plain", sizeBytes: 1, sha256: id });
  await db.insert(receiptItems).values(items.map((it, i) => ({
    id: uuid(), householdId, receiptId: id, lineNo: i + 1, rawName: it.raw, productName: it.raw, categoryId: it.cat, quantityMilli: it.qty ?? 1000, totalCents: it.cents,
  })));
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ({ householdId: hid } = await insertHousehold(db));
  const { accountId } = await insertAccount(db, hid, { name: "Card" });
  const { groupId } = await insertCategoryGroup(db, hid, { name: "Spending" });
  const { categoryId: groc } = await insertCategory(db, hid, groupId, { name: "Groceries" });
  const { categoryId: home } = await insertCategory(db, hid, groupId, { name: "Home Goods" });
  const mk = async (date: string, name: string) =>
    (await insertTransaction(db, hid, accountId, { date, name, originalName: name, amount: 1000, normalizedAmount: -1000 })).transactionId;
  await addReceipt(hid, await mk("2026-11-16", "Sams Club.com DDA PIN POS PUR CD1322 Bentonville"), [{ raw: "Rotisserie Chicken", cat: groc, cents: 498 }, { raw: "Paper Towels", cat: home, cents: 2000 }]);
  await addReceipt(hid, await mk("2026-11-09", "Walmart"), [{ raw: "Eggs", cat: groc, cents: 404 }]);
  await addReceipt(hid, await mk("2026-05-01", "Walmart"), [{ raw: "Ancient Beans", cat: groc, cents: 100 }]); // outside 120 days
  ({ householdId: bareHid } = await insertHousehold(db, "Bare"));
});

afterAll(async () => {
  await close();
});

describe("buildGroceryResponse", () => {
  it("returns only recent Groceries lines in the planner shape, with the store", async () => {
    const r = await buildGroceryResponse(hid, db, "2026-11-21");
    expect(r.source).toBe("Ledgr");
    expect(r.asOf).toBe("2026-11-21");
    const byName = Object.fromEntries(r.items.map((i) => [i.name, i]));
    expect(Object.keys(byName).sort()).toEqual(["Eggs", "Rotisserie Chicken"]);
    expect(byName["Rotisserie Chicken"]).toEqual({ name: "Rotisserie Chicken", last: "2026-11-16", count: 1, cents: 498, store: "Sam's Club" });
    expect(byName.Eggs.store).toBe("Walmart");
  });
  it("returns an empty list, not an error, when there is no Groceries category", async () => {
    const r = await buildGroceryResponse(bareHid, db, "2026-11-21");
    expect(r.items).toEqual([]);
  });
});

describe("resolveHouseholdId", () => {
  it("prefers the env value", async () => {
    expect(await resolveHouseholdId("abc", db)).toBe("abc");
  });
  it("refuses to guess when there are several households", async () => {
    await expect(resolveHouseholdId(undefined, db)).rejects.toThrow(/GROCERY_API_HOUSEHOLD_ID/);
  });
});

describe("route", () => {
  const OLD = { ...process.env };
  afterEach(() => { process.env = { ...OLD }; });
  const call = async (method: "GET" | "OPTIONS", headers: Record<string, string> = {}) => {
    const mod = await import("../../src/app/api/grocery-items/route");
    return mod[method](new Request("http://localhost/api/grocery-items", { method, headers }));
  };

  it("is a 404 when no key is configured, whatever is sent", async () => {
    delete process.env.GROCERY_API_KEY;
    expect((await call("GET", { Authorization: "Bearer anything" })).status).toBe(404);
    expect((await call("OPTIONS", { Origin: "http://a.test" })).status).toBe(404);
  });
  it("is a 401 for a wrong or malformed key and does not echo the key", async () => {
    process.env.GROCERY_API_KEY = "right-key";
    for (const h of [{} as Record<string, string>, { Authorization: "Bearer wrong" }, { Authorization: "Bearer " }, { Authorization: "Basic right-key" }]) {
      const res = await call("GET", h);
      expect(res.status).toBe(401);
      expect(JSON.stringify(await res.json())).not.toContain("right-key");
    }
  });
  it("answers the preflight for an allowed origin only", async () => {
    process.env.GROCERY_API_KEY = "k";
    process.env.GROCERY_API_ORIGINS = "http://a.test";
    const ok = await call("OPTIONS", { Origin: "http://a.test" });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("http://a.test");
    const bad = await call("OPTIONS", { Origin: "http://evil.test" });
    expect(bad.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
  it("puts no CORS headers on a 401 for a disallowed origin", async () => {
    process.env.GROCERY_API_KEY = "k";
    process.env.GROCERY_API_ORIGINS = "http://a.test";
    const res = await call("GET", { Origin: "http://evil.test", Authorization: "Bearer nope" });
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
