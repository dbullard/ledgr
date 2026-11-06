import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildReceiptRelPath, resolveReceiptPath, receiptsRoot, type ReceiptNameParts } from "./paths";

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** First free relative path for these name parts (adds -2, -3... on collision). */
export async function allocateReceiptPath(
  parts: Omit<ReceiptNameParts, "attempt">,
  root: string = receiptsRoot(),
): Promise<string> {
  for (let attempt = 1; attempt < 1000; attempt++) {
    const rel = buildReceiptRelPath({ ...parts, attempt });
    if (!(await exists(resolveReceiptPath(rel, root)))) return rel;
  }
  throw new Error("Could not allocate a receipt filename");
}

/** Writes the file without overwriting; returns the relative path used. */
export async function writeReceipt(
  data: Buffer,
  parts: Omit<ReceiptNameParts, "attempt">,
  root: string = receiptsRoot(),
): Promise<string> {
  const rel = await allocateReceiptPath(parts, root);
  const full = resolveReceiptPath(rel, root);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data, { flag: "wx" });
  return rel;
}

/** Moves a stored receipt to a new name (e.g. once it is attached). */
export async function moveReceipt(
  fromRel: string,
  parts: Omit<ReceiptNameParts, "attempt">,
  root: string = receiptsRoot(),
): Promise<string> {
  const toRel = await allocateReceiptPath(parts, root);
  const to = resolveReceiptPath(toRel, root);
  await fs.mkdir(path.dirname(to), { recursive: true });
  // rename fails across filesystems (e.g. a NAS mount); fall back to copy+delete.
  const from = resolveReceiptPath(fromRel, root);
  try {
    await fs.rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await fs.copyFile(from, to);
    await fs.unlink(from);
  }
  return toRel;
}

export async function readReceipt(rel: string, root: string = receiptsRoot()): Promise<Buffer> {
  return fs.readFile(resolveReceiptPath(rel, root));
}

export async function deleteReceiptFile(rel: string, root: string = receiptsRoot()): Promise<void> {
  await fs.rm(resolveReceiptPath(rel, root), { force: true });
}
