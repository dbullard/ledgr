import { describe, expect, it } from "vitest";
import { checkBearer, corsHeaders, toGroceryItems } from "../../src/lib/grocery-items";
import type { TopProductRow } from "../../src/queries/receipt-items";

describe("checkBearer", () => {
  it("is disabled when no key is configured", () => {
    expect(checkBearer("Bearer k", undefined)).toBe("disabled");
    expect(checkBearer(null, "")).toBe("disabled");
  });
  it("denies missing, empty, wrong-scheme and wrong keys", () => {
    expect(checkBearer(null, "k")).toBe("denied");
    expect(checkBearer("Bearer ", "k")).toBe("denied");
    expect(checkBearer("Basic k", "k")).toBe("denied");
    expect(checkBearer("Bearer kk", "k")).toBe("denied");
    expect(checkBearer("Bearer j", "k")).toBe("denied");
  });
  it("accepts the right key", () => {
    expect(checkBearer("Bearer k", "k")).toBe("ok");
  });
});

describe("corsHeaders", () => {
  it("allows only listed origins, exactly", () => {
    const h = corsHeaders("http://a.test", "http://a.test, http://b.test");
    expect(h["Access-Control-Allow-Origin"]).toBe("http://a.test");
    expect(h["Access-Control-Allow-Headers"]).toContain("Authorization");
    expect(corsHeaders("http://evil.test", "http://a.test")).toEqual({});
    expect(corsHeaders("http://a.test.evil.test", "http://a.test")).toEqual({});
    expect(corsHeaders(null, "http://a.test")).toEqual({});
    expect(corsHeaders("http://a.test", undefined)).toEqual({});
  });
});

const row = (over: Partial<TopProductRow>): TopProductRow => ({
  key: "k", name: "Eggs", totalCents: 1000, purchases: 3, lastDate: "2026-11-16", avgUnitCents: 266, stores: [], storeCount: 0, ...over,
});

describe("toGroceryItems", () => {
  it("maps to the planner shape and picks the most-bought store", () => {
    const [i] = toGroceryItems([row({ stores: [{ name: "Sam's Club", count: 1 }, { name: "Walmart", count: 4 }], storeCount: 2 })]);
    expect(i).toEqual({ name: "Eggs", last: "2026-11-16", count: 3, cents: 266, store: "Walmart" });
  });
  it("uses an empty store when none is known and rounds the price", () => {
    const [i] = toGroceryItems([row({ avgUnitCents: 266.6 })]);
    expect(i.store).toBe("");
    expect(i.cents).toBe(267);
  });
});
