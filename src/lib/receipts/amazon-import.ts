import { gte, inArray, lte, sql } from "drizzle-orm";
import Papa from "papaparse";
import type { LedgrDb } from "@/db";
import { receipts, transactions } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { isVisibleTransaction, notDeleted } from "@/lib/query-helpers";
import { withHousehold } from "@/lib/household-context";
import { saveStructuredReceipt } from "./service";

/**
 * Backfills item-level receipts from an Amazon "Your Orders" data export
 * (Your Amazon Orders/Order History.csv). No AI: a charge is matched to a
 * shipment (items sharing an order and ship date), else a whole order, else one
 * item, by amount to the cent and date within 7 days. Items are categorized by
 * keyword. Same rules as ledgr-agent/amazon_match.py.
 *
 * Item amounts are the export's per-line "Total Amount" (price, tax and
 * discounts), so the items add up to the card charge.
 */

export interface AmazonItem {
  name: string;
  qty: number;
  cents: number;
  category: string;
}

export interface AmazonUnit {
  orderId: string;
  /** YYYY-MM-DD: the ship date, or the order date when there is none */
  date: string;
  totalCents: number;
  items: AmazonItem[];
  /** 0 = one shipment, 1 = whole order, 2 = single item; lower wins ties */
  rank: number;
  rows: number[];
}

// First match wins. Items with no keyword fall back to the Amazon department, then Home Goods.
const RULES: [string, RegExp][] = [
  ["Music Gear", /guitar|elixir|strings?\b.*(nickel|bass|coated)|pedal|\bamp\b|amplifier|fender|switchcraft|fretboard|capo|tuner|ukulele|\bbass\b|drum|synth|midi|instrument cable|patch cable|temple audio|pickup|\bpicks?\b|footswitch/i],
  ["Baby", /\bbaby|diaper|infant|toddler|child.?proof|pacifier|stroller|crib|\bkids?\b/i],
  ["Pharmacy", /probiotic|vitamin|supplement|melatonin|tylenol|ibuprofen|allergy|zyrtec|claritin|antacid|bandage|first aid|thermometer|pain relief|whey|protein|creatine|omega/i],
  ["Personal Care", /shampoo|conditioner|body wash|toothpaste|toothbrush|deodorant|razor|shaving|soap|lotion|sunscreen|floss|cologne|moisturiz|beard|hair /i],
  ["Clothing", /\bshirt|t-shirt|socks|underwear|boxer|\bjeans|\bjacket|pajama|shorts\b|hoodie|\bhat\b|\bcap\b|leggings|sneaker|shoes?\b|\bboots?\b|\bbelt\b|\bwallet\b|apparel|men's|women's/i],
  ["Groceries", /syrup|snack|beef stick|coffee beans|ground coffee|\btea\b|cereal|protein bar|sauce\b|seasoning|spice|honey|\bnuts?\b|candy|chocolate|\bpasta\b|\bflour\b|sugar\b|jerky|monin|torani/i],
  ["Electronics", /cable|charger|charging|usb|hdmi|magsafe|iphone|apple watch|watch band|sport band|airpods|headphone|earbud|\bbattery|batteries|bluetooth|speaker|\btv\b|monitor|keyboard|\bmouse\b|sd card|ssd|hard drive|router|camera|smartwatch|adapter|solder|multimeter|raspberry|arduino|power bank|screen protector|phone case|\bcase for|extension cord|surge|smart plug|alexa|echo\b|kindle|webcam|microphone|\bled strip/i],
  ["Entertainment", /\bgame\b|\btoy|lego|puzzle|\bbook\b|paperback|hardcover|\bdvd|blu-ray|vinyl|\bcd\b|\bnfl\b|playing cards|board game|poster|record\b/i],
  ["Education", /handbook|textbook|workbook|course|study guide|bible|theology|church history|practicing the way|devotional/i],
  ["Home Goods", /mop|broom|sponge|cleaner|cleaning|trash bag|storage|organizer|hanger|towel|sheet|pillow|blanket|candle|light bulb|\bbulb|kitchen|lunch box|garden|hose|sprinkler|lawn|tool|drawer|cord hider|outlet|ratchet|strap|grill|brush|filter|vacuum|paint|tape|\bscrews?\b|hardware/i],
];

const DEPARTMENTS: Record<string, string> = {
  Electronics: "Electronics",
  "Personal Computers": "Electronics",
  "Wireless Phone Accessory": "Electronics",
  Camera: "Electronics",
  "Video Game": "Entertainment",
  Vinyl: "Entertainment",
  DVD: "Entertainment",
  Paperback: "Entertainment",
  Hardcover: "Entertainment",
  Apparel: "Clothing",
  Shoes: "Clothing",
  "Health and Beauty": "Personal Care",
  Grocery: "Groceries",
  "Baby Product": "Baby",
  Kitchen: "Home Goods",
  "Tools & Home Improvement": "Home Goods",
  "Tools & Hardware": "Home Goods",
  "Lawn & Patio": "Home Goods",
  "Office Product": "Home Goods",
  Automotive: "Maintenance",
};

export function categorizeAmazonItem(name: string, department = ""): string {
  for (const [cat, rx] of RULES) if (rx.test(name)) return cat;
  return DEPARTMENTS[department] ?? "Home Goods";
}

function cents(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v.replace(/[$,']/g, "")) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const day = (v: string | undefined): string | null => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/** Reads Order History.csv into the shipments, orders and single items a card charge could be. */
export function parseAmazonOrders(csv: string): { units: AmazonUnit[]; lines: number } | { error: string } {
  const parsed = Papa.parse<Record<string, string>>(csv.replace(/^﻿/, ""), { header: true, skipEmptyLines: true });
  const need = ["Order ID", "Order Date", "Product Name", "Total Amount", "Order Status"];
  if (!parsed.meta.fields || need.some((f) => !parsed.meta.fields!.includes(f))) {
    return { error: "That doesn't look like Amazon's Order History.csv (expected Order ID, Order Date, Product Name, Total Amount)" };
  }
  type Line = { orderId: string; orderDate: string; shipDate: string | null; item: AmazonItem };
  const lines: Line[] = [];
  for (const r of parsed.data) {
    if (r["Order Status"] === "Cancelled") continue;
    const total = cents(r["Total Amount"]);
    const orderDate = day(r["Order Date"]);
    const name = (r["Product Name"] ?? "").replace(/\s+/g, " ").trim();
    const orderId = (r["Order ID"] ?? "").trim();
    if (!orderId || !orderDate || !name || total === null || total <= 0) continue;
    const q = Number(r["Original Quantity"]);
    lines.push({
      orderId,
      orderDate,
      shipDate: day(r["Ship Date"]),
      item: {
        name: name.slice(0, 200),
        qty: Number.isFinite(q) && q > 0 ? q : 1,
        cents: total,
        category: categorizeAmazonItem(name, r["Department"] ?? ""),
      },
    });
  }

  const units: AmazonUnit[] = [];
  const make = (rank: number, idxs: number[], date: string): AmazonUnit => ({
    orderId: lines[idxs[0]].orderId,
    date,
    totalCents: idxs.reduce((s, i) => s + lines[i].item.cents, 0),
    items: idxs.map((i) => lines[i].item),
    rank,
    rows: idxs,
  });
  const byShipment = new Map<string, number[]>();
  const byOrder = new Map<string, number[]>();
  lines.forEach((l, i) => {
    const sk = `${l.orderId}|${l.shipDate ?? ""}`;
    byShipment.set(sk, [...(byShipment.get(sk) ?? []), i]);
    byOrder.set(l.orderId, [...(byOrder.get(l.orderId) ?? []), i]);
  });
  for (const idxs of byShipment.values()) units.push(make(0, idxs, lines[idxs[0]].shipDate ?? lines[idxs[0]].orderDate));
  for (const idxs of byOrder.values()) units.push(make(1, idxs, lines[idxs[0]].orderDate));
  lines.forEach((l, i) => units.push(make(2, [i], l.shipDate ?? l.orderDate)));
  return { units, lines: lines.length };
}

export interface AmazonMatch {
  unit: AmazonUnit;
  transactionId: string;
  /** YYYY-MM-DD of the charge */
  chargeDate: string;
  daysApart: number;
  /** Set when the charge already has an itemized or imported receipt. */
  skip: "already-itemized" | null;
}

export interface AmazonPlan {
  matches: AmazonMatch[];
  amazonChargesWithoutOrder: number;
}

const AMAZON_NAME = "amazon|amzn";
// Memberships and digital purchases are not in Order History.
const NOT_ORDERS = "prime|kindle|audible|digital";
const MAX_DAYS = 7;

function dayDiff(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** Matches card charges to shipments, orders or items: same amount to the cent, within 7 days, no item used twice. */
export async function planAmazonImport(householdId: string, units: AmazonUnit[], tx: LedgrDb): Promise<AmazonPlan> {
  if (units.length === 0) return { matches: [], amazonChargesWithoutOrder: 0 };
  const dates = units.map((u) => u.date).sort();
  const shift = (d: string, n: number) =>
    new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const scoped = scopedQuery(householdId, tx);

  const charges = await tx
    .select({ id: transactions.id, date: transactions.date, amount: transactions.normalizedAmount })
    .from(transactions)
    .where(
      scoped.where(
        transactions,
        notDeleted(transactions),
        isVisibleTransaction(transactions),
        gte(transactions.date, shift(dates[0], -MAX_DAYS)),
        lte(transactions.date, shift(dates[dates.length - 1], MAX_DAYS)),
        sql`${transactions.normalizedAmount} < 0`,
        sql`(${transactions.originalName} ~* ${AMAZON_NAME} OR ${transactions.name} ~* ${AMAZON_NAME})`,
        sql`NOT (${transactions.originalName} ~* ${NOT_ORDERS} OR ${transactions.name} ~* ${NOT_ORDERS})`,
      ),
    )
    .orderBy(transactions.date);

  const existing = charges.length
    ? await tx
        .select({ transactionId: receipts.transactionId, source: receipts.source, parsedAt: receipts.parsedAt })
        .from(receipts)
        .where(
          scoped.where(
            receipts,
            inArray(
              receipts.transactionId,
              charges.map((c) => c.id),
            ),
          ),
        )
    : [];
  const itemized = new Set(
    existing.filter((r) => r.parsedAt !== null || r.source === "import").map((r) => r.transactionId),
  );

  const usedRows = new Set<string>();
  const matches: AmazonMatch[] = [];
  for (const c of charges) {
    const want = -c.amount;
    let best: AmazonUnit | null = null;
    let bestGap = Infinity;
    for (const u of units) {
      if (Math.abs(u.totalCents - want) > 1) continue;
      if (u.rows.some((r) => usedRows.has(`${u.orderId}#${r}`))) continue;
      const gap = dayDiff(u.date, c.date);
      if (gap > MAX_DAYS) continue;
      if (gap < bestGap || (gap === bestGap && best && u.rank < best.rank)) {
        best = u;
        bestGap = gap;
      }
    }
    if (best) {
      for (const r of best.rows) usedRows.add(`${best.orderId}#${r}`);
      matches.push({
        unit: best,
        transactionId: c.id,
        chargeDate: c.date,
        daysApart: bestGap,
        skip: itemized.has(c.id) ? "already-itemized" : null,
      });
    }
  }
  return { matches, amazonChargesWithoutOrder: charges.length - matches.length };
}

export interface AmazonImportResult {
  imported: number;
  skipped: number;
  duplicates: number;
  failed: number;
  items: number;
}

/** Saves every unskipped match as an itemized receipt attached to its charge. */
export async function applyAmazonImport(
  householdId: string,
  plan: AmazonPlan,
  db: LedgrDb,
  root?: string,
): Promise<AmazonImportResult> {
  const out: AmazonImportResult = { imported: 0, skipped: 0, duplicates: 0, failed: 0, items: 0 };
  for (const m of plan.matches) {
    if (m.skip) {
      out.skipped++;
      continue;
    }
    try {
      const res = await withHousehold(
        householdId,
        (tx) =>
          saveStructuredReceipt({
            householdId,
            db: tx,
            source: "import",
            merchant: "Amazon",
            date: m.unit.date,
            totalCents: m.unit.totalCents,
            taxCents: 0, // item amounts already include tax
            transactionId: m.transactionId,
            root,
            items: m.unit.items.map((it) => ({
              name: it.name,
              totalCents: it.cents,
              quantity: it.qty,
              product: it.name.split(",")[0].trim().slice(0, 80),
              category: it.category,
            })),
          }),
        db,
      );
      if (res.status === "duplicate") out.duplicates++;
      else if (res.status === "error") out.failed++;
      else {
        out.imported++;
        out.items += res.itemCount;
      }
    } catch (e) {
      console.error("[receipts] amazon import failed for one order", e);
      out.failed++;
    }
  }
  return out;
}
