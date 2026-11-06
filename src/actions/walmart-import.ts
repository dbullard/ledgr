"use server";

import { db as defaultDb, type LedgrDb } from "@/db";
import { authorizeAction } from "@/lib/auth/authorize-action";
import { withHousehold } from "@/lib/household-context";
import { receiptsRoot } from "@/lib/receipts/paths";
import {
  applyWalmartImport,
  parseWalmartWorkbook,
  planWalmartImport,
  type WalmartImportResult,
} from "@/lib/receipts/walmart-import";

const MAX_BYTES = 20 * 1024 * 1024;

export interface WalmartPreview {
  ordersInFile: number;
  toImport: number;
  alreadyItemized: number;
  unmatchedOrders: number;
  walmartChargesWithoutOrder: number;
  itemsToImport: number;
}

async function readFile(formData: FormData) {
  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "Choose the Walmart_Orders.xlsx file" } as const;
  if (!file.name.toLowerCase().endsWith(".xlsx")) return { error: "Choose an .xlsx file" } as const;
  if (file.size > MAX_BYTES) return { error: "File is larger than 20 MB" } as const;
  return parseWalmartWorkbook(Buffer.from(await file.arrayBuffer()));
}

/** What an import would do, without changing anything. */
export async function previewWalmartImport(
  formData: FormData,
  db: LedgrDb = defaultDb,
): Promise<{ data: WalmartPreview } | { error: string }> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  const parsed = await readFile(formData);
  if ("error" in parsed) return parsed;

  const plan = await withHousehold(auth.householdId, (tx) => planWalmartImport(auth.householdId, parsed.orders, tx), db);
  const todo = plan.matches.filter((m) => !m.skip);
  return {
    data: {
      ordersInFile: plan.ordersInFile,
      toImport: todo.length,
      alreadyItemized: plan.matches.length - todo.length,
      unmatchedOrders: plan.unmatchedOrders,
      walmartChargesWithoutOrder: plan.walmartChargesWithoutOrder,
      itemsToImport: todo.reduce((s, m) => s + m.order.items.length, 0),
    },
  };
}

/** Saves each matched order as an itemized receipt on its Walmart charge. Safe to run again. */
export async function importWalmartOrders(
  formData: FormData,
  db: LedgrDb = defaultDb,
  root: string = receiptsRoot(),
): Promise<{ data: WalmartImportResult } | { error: string }> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  const parsed = await readFile(formData);
  if ("error" in parsed) return parsed;

  const plan = await withHousehold(auth.householdId, (tx) => planWalmartImport(auth.householdId, parsed.orders, tx), db);
  return { data: await applyWalmartImport(auth.householdId, plan, db, root) };
}
