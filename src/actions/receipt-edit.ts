"use server";

import { z } from "zod";
import { db as defaultDb, type LedgrDb } from "@/db";
import { authorizeAction } from "@/lib/auth/authorize-action";
import { getHouseholdId } from "@/lib/auth/session";
import { withHousehold } from "@/lib/household-context";
import {
  applyReceiptEdits,
  loadReceiptEditData,
  receiptEditSchema,
  type ReceiptEditData,
} from "@/lib/receipts/edit";

const idSchema = z.string().min(1);

/** What the edit form opens with: the receipt's total, date, merchant and lines. */
export async function fetchReceiptForEdit(
  receiptId: string,
  db: LedgrDb = defaultDb,
): Promise<{ data: ReceiptEditData } | { error: string }> {
  const householdId = await getHouseholdId();
  const id = idSchema.safeParse(receiptId);
  if (!id.success) return { error: "Invalid input" };
  const data = await withHousehold(householdId, (tx) => loadReceiptEditData(tx, householdId, id.data), db);
  return data ? { data } : { error: "Receipt not found" };
}

/** Saves the whole edit form at once; on any error nothing is written. */
export async function saveReceiptEdits(
  receiptId: string,
  edits: unknown,
  db: LedgrDb = defaultDb,
): Promise<{ data: ReceiptEditData } | { error: string }> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  const { householdId } = auth;
  const id = idSchema.safeParse(receiptId);
  if (!id.success) return { error: "Invalid input" };
  const parsed = receiptEditSchema.safeParse(edits);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  return withHousehold(
    householdId,
    async (tx) => {
      const res = await applyReceiptEdits(tx, householdId, id.data, parsed.data);
      if ("error" in res) return res;
      const data = await loadReceiptEditData(tx, householdId, id.data);
      return data ? { data } : { error: "Receipt not found" };
    },
    db,
  );
}
