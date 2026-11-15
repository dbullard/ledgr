"use server";

import { db as defaultDb, type LedgrDb } from "@/db";
import { authorizeAction } from "@/lib/auth/authorize-action";
import { withHousehold } from "@/lib/household-context";
import { receiptsRoot } from "@/lib/receipts/paths";
import {
  applyAmazonImport,
  parseAmazonOrders,
  planAmazonImport,
  type AmazonImportResult,
} from "@/lib/receipts/amazon-import";

const MAX_BYTES = 20 * 1024 * 1024;

export interface AmazonPreview {
  orderLines: number;
  toImport: number;
  alreadyItemized: number;
  amazonChargesWithoutOrder: number;
  itemsToImport: number;
}

async function readFile(formData: FormData) {
  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "Choose Amazon's Order History.csv file" } as const;
  if (!file.name.toLowerCase().endsWith(".csv")) return { error: "Choose a .csv file" } as const;
  if (file.size > MAX_BYTES) return { error: "File is larger than 20 MB" } as const;
  return parseAmazonOrders(await file.text());
}

/** What an import would do, without changing anything. */
export async function previewAmazonImport(
  formData: FormData,
  db: LedgrDb = defaultDb,
): Promise<{ data: AmazonPreview } | { error: string }> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  const parsed = await readFile(formData);
  if ("error" in parsed) return parsed;

  const plan = await withHousehold(auth.householdId, (tx) => planAmazonImport(auth.householdId, parsed.units, tx), db);
  const todo = plan.matches.filter((m) => !m.skip);
  return {
    data: {
      orderLines: parsed.lines,
      toImport: todo.length,
      alreadyItemized: plan.matches.length - todo.length,
      amazonChargesWithoutOrder: plan.amazonChargesWithoutOrder,
      itemsToImport: todo.reduce((s, m) => s + m.unit.items.length, 0),
    },
  };
}

/** Saves each matched order as an itemized receipt on its Amazon charge. Safe to run again. */
export async function importAmazonOrders(
  formData: FormData,
  db: LedgrDb = defaultDb,
  root: string = receiptsRoot(),
): Promise<{ data: AmazonImportResult } | { error: string }> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  const parsed = await readFile(formData);
  if ("error" in parsed) return parsed;

  const plan = await withHousehold(auth.householdId, (tx) => planAmazonImport(auth.householdId, parsed.units, tx), db);
  return { data: await applyAmazonImport(auth.householdId, plan, db, root) };
}
