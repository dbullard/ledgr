import fs from "node:fs/promises";
import path from "node:path";
import { db as defaultDb, type LedgrDb } from "@/db";
import { households } from "@/db/schema";
import { withHousehold } from "@/lib/household-context";
import { ingestReceipt } from "./ingest";
import { receiptExtension, receiptsRoot } from "./paths";

/** Files newer than this may still be copying in over the network. */
const SETTLE_MS = 15_000;

export interface InboxScanResult {
  stored: number;
  attached: number;
  duplicates: number;
  skipped: number;
}

/**
 * Picks up files dropped into <root>/inbox (e.g. from a phone scanner or a
 * NAS share), stores them as receipts and removes them from the inbox.
 * Self-hosted Ledgr normally has one household; with several there is no way
 * to know whose receipt a loose file is, so nothing is ingested.
 */
export async function scanReceiptInbox(
  opts: { db?: LedgrDb; root?: string; now?: number } = {},
): Promise<InboxScanResult> {
  const db = opts.db ?? defaultDb;
  const root = opts.root ?? receiptsRoot();
  const now = opts.now ?? Date.now();
  const inbox = path.join(root, "inbox");
  const result: InboxScanResult = { stored: 0, attached: 0, duplicates: 0, skipped: 0 };

  let names: string[];
  try {
    names = await fs.readdir(inbox);
  } catch {
    return result; // no inbox folder: nothing to do
  }
  if (names.length === 0) return result;

  const owners = await db.select({ id: households.id }).from(households).limit(2);
  if (owners.length !== 1) {
    console.warn("[receipts] inbox ignored: needs exactly one household");
    return result;
  }
  const householdId = owners[0].id;

  for (const name of names) {
    const file = path.join(inbox, name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile() || name.startsWith(".")) continue;
    if (now - stat.mtimeMs < SETTLE_MS) continue;

    if (!receiptExtension(name)) {
      await moveAside(inbox, name);
      result.skipped++;
      continue;
    }
    try {
      const data = await fs.readFile(file);
      const res = await withHousehold(
        householdId,
        (tx) => ingestReceipt({ householdId, data, filename: name, source: "folder", db: tx, root }),
        db,
      );
      if (res.status === "rejected") {
        await moveAside(inbox, name);
        result.skipped++;
        continue;
      }
      await fs.unlink(file);
      if (res.status === "duplicate") result.duplicates++;
      else {
        result.stored++;
        if (res.transactionId) result.attached++;
      }
    } catch (err) {
      console.error(`[receipts] could not ingest inbox file ${name}`, err); // left in place to retry
    }
  }
  return result;
}

async function moveAside(inbox: string, name: string): Promise<void> {
  const dir = path.join(inbox, "_skipped");
  await fs.mkdir(dir, { recursive: true });
  await fs.rename(path.join(inbox, name), path.join(dir, name));
}
