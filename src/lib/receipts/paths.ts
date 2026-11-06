import path from "node:path";

export const MAX_RECEIPT_BYTES = 15 * 1024 * 1024;

/** Allow-list: extension -> content type. Anything else is rejected. */
export const RECEIPT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
  txt: "text/plain",
  eml: "message/rfc822",
};

export function receiptsRoot(env: Record<string, string | undefined> = process.env): string {
  if (env.RECEIPTS_DIR) return path.resolve(env.RECEIPTS_DIR);
  return path.resolve(env.LEDGR_DATA_DIR ?? "/data", "receipts");
}

/** Lowercased extension without the dot, or null if not allow-listed. */
export function receiptExtension(filename: string): string | null {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return ext in RECEIPT_TYPES ? ext : null;
}

export function slugify(input: string, maxLen = 40): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return slug || "unknown";
}

export interface ReceiptNameParts {
  /** YYYY-MM-DD: the transaction date when attached, else the upload date. */
  date: string;
  /** Absolute transaction amount in cents; omit for unmatched receipts. */
  amountCents?: number | null;
  merchant?: string | null;
  ext: string;
  /** Used for unmatched receipts so identical uploads on one day stay distinct. */
  hash?: string;
  /** 1 = no suffix; 2+ appends -N to resolve a collision. */
  attempt?: number;
}

/** `<YYYY>/<MM>/<YYYY-MM-DD>_<merchant>_<amount>.<ext>` relative to the root. */
export function buildReceiptRelPath(p: ReceiptNameParts): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new Error("Invalid receipt date");
  if (!(p.ext in RECEIPT_TYPES)) throw new Error("Unsupported receipt type");
  const [year, month] = p.date.split("-");
  const parts = [p.date, slugify(p.merchant ?? "unmatched")];
  if (p.amountCents != null) {
    const cents = Math.abs(Math.trunc(p.amountCents));
    parts.push(`${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`);
  } else if (p.hash) {
    parts.push(p.hash.slice(0, 8));
  }
  const suffix = p.attempt && p.attempt > 1 ? `-${p.attempt}` : "";
  return path.posix.join(year, month, `${parts.join("_")}${suffix}.${p.ext}`);
}

/** Resolves a stored relative path, refusing anything that escapes the root. */
export function resolveReceiptPath(rel: string, root: string = receiptsRoot()): string {
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, rel);
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
    throw new Error("Receipt path escapes the receipts root");
  }
  return full;
}
