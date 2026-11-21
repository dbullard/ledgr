import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db as defaultDb, type LedgrDb } from "@/db";
import { categories, households } from "@/db/schema";
import { getTopProducts, type TopProductRow } from "@/queries/receipt-items";
import { withHousehold } from "@/lib/household-context";
import { todayDateString } from "@/lib/date-utils";

/**
 * Read-only grocery lines for the dinner planner. Off unless GROCERY_API_KEY
 * is set. Shape matches what the planner already reads from its own file.
 */
export interface GroceryItem {
  name: string;
  last: string;
  count: number;
  cents: number;
  store: string;
}

export function checkBearer(header: string | null, key: string | undefined): "ok" | "disabled" | "denied" {
  if (!key) return "disabled";
  if (!header || !header.startsWith("Bearer ")) return "denied";
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(key);
  if (given.length === 0 || given.length !== want.length) return "denied";
  return timingSafeEqual(given, want) ? "ok" : "denied";
}

export function corsHeaders(origin: string | null, allowed: string | undefined): Record<string, string> {
  if (!origin || !allowed) return {};
  const ok = allowed.split(",").map((s) => s.trim()).filter(Boolean).includes(origin);
  if (!ok) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function toGroceryItems(rows: TopProductRow[]): GroceryItem[] {
  return rows.map((r) => {
    const store = [...r.stores].sort((a, b) => b.count - a.count)[0];
    return { name: r.name, last: r.lastDate, count: r.purchases, cents: Math.round(r.avgUnitCents), store: store ? store.name : "" };
  });
}

export const GROCERY_DAYS = 120;
export const GROCERY_LIMIT = 100;

/** The household the key reads: GROCERY_API_HOUSEHOLD_ID, else the only one. Throws if that is ambiguous. */
export async function resolveHouseholdId(envId: string | undefined, db: LedgrDb = defaultDb): Promise<string> {
  if (envId) return envId;
  const all = await db.select({ id: households.id }).from(households).limit(2);
  if (all.length !== 1) throw new Error("Set GROCERY_API_HOUSEHOLD_ID: Ledgr has " + (all.length === 0 ? "no" : "more than one") + " household");
  return all[0].id;
}

export async function buildGroceryResponse(householdId: string, db: LedgrDb = defaultDb, today = todayDateString()) {
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - GROCERY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const [cat] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.householdId, householdId), eq(categories.name, "Groceries")))
    .limit(1);
  const items = cat
    ? toGroceryItems(
        await withHousehold(
          householdId,
          (tx) => getTopProducts(householdId, { dateFrom: from, dateTo: today, categoryId: cat.id }, GROCERY_LIMIT, tx, { sort: "last" }),
          db,
        ),
      )
    : [];
  return { source: "Ledgr", asOf: today, items };
}
