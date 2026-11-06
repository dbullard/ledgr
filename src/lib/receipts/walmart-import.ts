import { gte, inArray, lte, sql } from "drizzle-orm";
import type { LedgrDb } from "@/db";
import { receipts, transactions } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { isVisibleTransaction, notDeleted } from "@/lib/query-helpers";
import { withHousehold } from "@/lib/household-context";
import { saveStructuredReceipt } from "./service";

/**
 * Backfills item-level receipts from a Walmart order-history export (.xlsx with
 * "Orders" and "Items" sheets). No AI: orders are matched to the household's
 * Walmart charges by amount and date, and items are categorized by keyword.
 */

export interface WalmartItem {
  name: string;
  qty: number;
  cents: number;
}

export interface WalmartOrder {
  orderNumber: string;
  /** YYYY-MM-DD */
  date: string;
  totalCents: number;
  taxCents: number;
  items: WalmartItem[];
}

// First match wins; anything unmatched is Groceries (most of a Walmart order).
// Same rules as ledgr-agent/walmart_match.py.
const RULES: [string, RegExp][] = [
  ["Gas", /gasoline|unleaded|diesel|\bfuel\b/i],
  ["Baby", /diaper|wipes.*baby|baby|infant|formula|pampers|huggies|toddler|pacifier|similac|enfamil/i],
  ["Pharmacy", /vitamin|tylenol|ibuprofen|advil|motrin|allergy|zyrtec|claritin|cough|cold &|antacid|bandage|first aid|supplement|melatonin|probiotic|pepto|tums|nasal|thermometer|pain relief/i],
  ["Personal Care", /shampoo|conditioner|body wash|toothpaste|toothbrush|mouthwash|deodorant|razor|shaving|soap|lotion|sunscreen|floss|feminine|tampon|pads\b|cosmetic|mascara|lip |hair |skin|nail|perfume|cologne|moisturiz/i],
  ["Clothing", /\bshirt|socks|underwear|jeans|\bjacket|pajama|shorts\b|hoodie|\bhat\b|dress\b|leggings|sneaker|shoes?\b|\bbra\b/i],
  ["Electronics", /\bcable\b|charger|usb|headphone|earbud|battery|batteries|hdmi|\bphone case|bluetooth|speaker|\btv\b|monitor|keyboard|mouse\b|sd card/i],
  ["Entertainment", /\bgame\b|\btoy|lego|puzzle|\bbook\b|\bdvd|blu-ray|playing cards|\bcraft|coloring|crayon|marker|party|balloon/i],
  ["Home Goods", /paper towel|toilet paper|bath tissue|trash bag|laundry|detergent|dish |dishwasher|cleaner|cleaning|bleach|sponge|foil\b|plastic wrap|ziploc|storage|candle|air freshener|light bulb|\bbulb|towel|sheet|pillow|blanket|hanger|\bpet\b|dog food|cat food|litter|furniture|kitchen|\bpan\b|\bpot\b|organizer|tool|filter|vacuum|mop|broom|garden|potted plant|lawn|paint|duct tape|batteries/i],
];

export function categorizeWalmartItem(name: string): string {
  for (const [cat, rx] of RULES) if (rx.test(name)) return cat;
  return "Groceries";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v !== "string") return null;
  const m = v.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`;
}

function cents(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[$,]/g, "")) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function key(v: unknown): string {
  return typeof v === "number" ? String(v) : String(v ?? "").trim();
}

type Sheet = { sheet: string; data: unknown[][] };

/** Reads the Orders and Items sheets into orders with their items. */
export async function parseWalmartWorkbook(data: Buffer): Promise<{ orders: WalmartOrder[] } | { error: string }> {
  let sheets: Sheet[];
  try {
    const { default: readXlsxFile } = await import("read-excel-file/node");
    sheets = (await readXlsxFile(data)) as unknown as Sheet[];
  } catch {
    return { error: "That doesn't look like an .xlsx file" };
  }
  const orderSheet = sheets.find((s) => s.sheet === "Orders")?.data;
  const itemSheet = sheets.find((s) => s.sheet === "Items")?.data;
  if (!orderSheet || !itemSheet) return { error: 'Expected a Walmart export with "Orders" and "Items" sheets' };

  const col = (header: unknown[], name: string) => header.indexOf(name);
  const oh = orderSheet[0] ?? [];
  const ih = itemSheet[0] ?? [];
  const oNum = col(oh, "Order Number");
  const oDate = col(oh, "Order Date");
  const oTotal = col(oh, "Order Total");
  const oTax = col(oh, "Tax");
  const iNum = col(ih, "Order Number");
  const iName = col(ih, "Product Name");
  const iQty = col(ih, "Qty");
  const iPrice = col(ih, "Price");
  if ([oNum, oDate, oTotal, iNum, iName, iPrice].some((i) => i < 0)) {
    return { error: "The sheets are missing expected columns (Order Number, Order Date, Order Total, Product Name, Price)" };
  }

  const itemsByOrder = new Map<string, WalmartItem[]>();
  for (const row of itemSheet.slice(1)) {
    const name = String(row[iName] ?? "").replace(/\s+/g, " ").trim();
    const c = cents(row[iPrice]);
    if (!name || c === null || c === 0) continue;
    const qty = iQty >= 0 && typeof row[iQty] === "number" && (row[iQty] as number) > 0 ? (row[iQty] as number) : 1;
    const k = key(row[iNum]);
    if (!itemsByOrder.has(k)) itemsByOrder.set(k, []);
    itemsByOrder.get(k)!.push({ name, qty, cents: c });
  }

  const orders: WalmartOrder[] = [];
  for (const row of orderSheet.slice(1)) {
    const total = cents(row[oTotal]);
    const date = parseDate(row[oDate]);
    const k = key(row[oNum]);
    const items = itemsByOrder.get(k);
    if (!k || total === null || total <= 0 || !date || !items?.length) continue;
    orders.push({ orderNumber: k, date, totalCents: total, taxCents: oTax >= 0 ? (cents(row[oTax]) ?? 0) : 0, items });
  }
  return { orders };
}

export interface WalmartMatch {
  order: WalmartOrder;
  transactionId: string;
  daysApart: number;
  /** Set when the charge already has an itemized or imported receipt. */
  skip: "already-itemized" | null;
}

export interface WalmartPlan {
  matches: WalmartMatch[];
  ordersInFile: number;
  unmatchedOrders: number;
  walmartChargesWithoutOrder: number;
}

const WALMART_NAME = "walmart|wal-mart|wm supercenter";
const MAX_DAYS = 5;

function dayDiff(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** Matches orders to the household's Walmart charges: same amount to the cent, within 5 days, one-to-one. */
export async function planWalmartImport(
  householdId: string,
  orders: WalmartOrder[],
  tx: LedgrDb,
): Promise<WalmartPlan> {
  if (orders.length === 0) return { matches: [], ordersInFile: 0, unmatchedOrders: 0, walmartChargesWithoutOrder: 0 };
  const dates = orders.map((o) => o.date).sort();
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
        sql`(${transactions.originalName} ~* ${WALMART_NAME} OR ${transactions.name} ~* ${WALMART_NAME})`,
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

  const used = new Set<string>();
  const matches: WalmartMatch[] = [];
  for (const c of charges) {
    const cents = -c.amount;
    let best: WalmartOrder | null = null;
    let bestGap = Infinity;
    for (const o of orders) {
      if (used.has(o.orderNumber) || Math.abs(o.totalCents - cents) > 1) continue;
      const gap = dayDiff(o.date, c.date);
      if (gap <= MAX_DAYS && gap < bestGap) {
        best = o;
        bestGap = gap;
      }
    }
    if (best) {
      used.add(best.orderNumber);
      matches.push({
        order: best,
        transactionId: c.id,
        daysApart: bestGap,
        skip: itemized.has(c.id) ? "already-itemized" : null,
      });
    }
  }
  return {
    matches,
    ordersInFile: orders.length,
    unmatchedOrders: orders.length - matches.length,
    walmartChargesWithoutOrder: charges.length - matches.length,
  };
}

export interface WalmartImportResult {
  imported: number;
  skipped: number;
  duplicates: number;
  failed: number;
  items: number;
}

/** Saves every unskipped match as an itemized receipt attached to its charge. */
export async function applyWalmartImport(
  householdId: string,
  plan: WalmartPlan,
  db: LedgrDb,
  root?: string,
): Promise<WalmartImportResult> {
  const out: WalmartImportResult = { imported: 0, skipped: 0, duplicates: 0, failed: 0, items: 0 };
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
            merchant: "Walmart",
            date: m.order.date,
            totalCents: m.order.totalCents,
            taxCents: m.order.taxCents,
            transactionId: m.transactionId,
            root,
            items: m.order.items.map((it) => ({
              name: it.name.slice(0, 200),
              totalCents: it.cents,
              quantity: it.qty,
              product: it.name.split(",")[0].trim().slice(0, 80),
              category: categorizeWalmartItem(it.name),
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
      console.error("[receipts] walmart import failed for one order", e);
      out.failed++;
    }
  }
  return out;
}

