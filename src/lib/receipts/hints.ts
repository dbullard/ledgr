export interface ReceiptHints {
  totalCents: number | null;
  /** YYYY-MM-DD */
  date: string | null;
  merchant: string | null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function iso(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, m - 1, d);
  if (new Date(t).getUTCMonth() !== m - 1) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/** First recognizable date in the text: YYYY-MM-DD, MM/DD/YYYY or "Nov 2, 2026". */
export function findDate(text: string): string | null {
  let m = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (m) {
    const r = iso(+m[1], +m[2], +m[3]);
    if (r) return r;
  }
  m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2}|\d{2})\b/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const r = iso(y, +m[1], +m[2]);
    if (r) return r;
  }
  m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i);
  if (m) return iso(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]);
  return null;
}

function toCents(raw: string): number | null {
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

/**
 * The receipt total: the amount right after "grand total", "order total",
 * "total due", "amount due" or "total", ignoring "subtotal". Works on text
 * with or without line breaks (PDF extraction often has none). Later matches
 * win, since a receipt's final total comes last.
 */
export function findTotal(text: string): number | null {
  return findTotalMatch(text)?.cents ?? null;
}

function findTotalMatch(text: string): { cents: number; end: number } | null {
  const re =
    /(grand\s+total|order\s+total|total\s+due|amount\s+due|total)[\s:\-]*(?:usd)?\s*\$?\s*(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})/gi;
  let best: { cents: number; end: number } | null = null;
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, m.index - 4), m.index);
    if (/sub\s*-?$/i.test(before)) continue;
    const cents = toCents(m[2]);
    if (cents !== null) best = { cents, end: m.index + m[0].length };
  }
  return best;
}

/**
 * What the card was actually charged. Sam's Club prints the card line after the
 * total ("Ending in 1322  $101.21"): that amount is the charge, and it already
 * includes a driver tip when one was billed to the card (2026 orders) and not
 * when it wasn't (2025 orders). Without a card line, a "Driver tip" listed after
 * the total is added; a tip printed before the total is already part of it.
 */
export function findChargedTotal(text: string): number | null {
  const total = findTotalMatch(text);
  if (!total) return null;
  const after = text.slice(total.end);
  const AMOUNT = "(\\d{1,3}(?:,\\d{3})*\\.\\d{2}|\\d+\\.\\d{2})";
  const card = after.match(new RegExp(`(?:ending\\s+in\\s+|\\*)\\d{4}\\s+\\$?\\s*${AMOUNT}`, "i"));
  const cardCents = card ? toCents(card[1]) : null;
  if (cardCents !== null && cardCents >= total.cents) return cardCents;
  const tip = after.match(new RegExp(`\\b(?:driver|delivery)\\s+tip\\b[\\s:\\-]*\\$?\\s*${AMOUNT}`, "i"));
  const tipCents = tip ? toCents(tip[1]) : null;
  return total.cents + (tipCents ?? 0);
}

/** "Amazon <orders@amazon.com>" -> "Amazon". */
function emailSender(text: string): string | null {
  const m = text.match(/^from:\s*"?([^"<\r\n]+?)"?\s*(?:<[^>]*>)?\s*$/im);
  return m ? m[1].trim() : null;
}

const NOT_A_STORE = /receipt|invoice|order|date|total|thank|welcome|statement|page \d|https?:|@|\$|\d{1,2}[/:]\d{2}/i;

/** Stores print their name at the top: the first plausible short line of the text. */
export function merchantFromFirstLine(text: string): string | null {
  for (const raw of text.split(/\r?\n/).slice(0, 6)) {
    const line = raw.trim();
    if (line.length < 3 || line.length > 40 || NOT_A_STORE.test(line)) continue;
    const letters = (line.match(/[A-Za-z]/g) ?? []).length;
    if (letters >= 3 && letters >= line.length / 2) return line;
  }
  return null;
}

const STOP = new Set(["receipt", "invoice", "order", "scan", "img", "image", "photo", "pdf", "copy", "final"]);

/** Merchant-ish words from a filename, with dates, amounts and noise removed. */
export function merchantFromFilename(filename: string): string | null {
  const stem = filename.replace(/\.[^.]+$/, "");
  const words = stem
    .replace(/\d{4}[-_.]\d{2}[-_.]\d{2}/g, " ")
    .replace(/\d+[.,]\d{2}/g, " ")
    .split(/[^A-Za-z]+/)
    .filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()));
  return words.length ? words.join(" ").slice(0, 80) : null;
}

export function extractHints(filename: string, text: string | null): ReceiptHints {
  const stem = filename.replace(/\.[^.]+$/, "");
  const body = text ?? "";
  const fromBody = body.trim().length > 0;
  let totalCents = fromBody ? findChargedTotal(body) : null;
  if (totalCents === null) {
    // Filenames like "Amazon_75.39.pdf" carry the amount.
    const m = stem.match(/(?:^|[^\d])(\d{1,5}\.\d{2})(?!\d)/);
    if (m) totalCents = toCents(m[1]);
  }
  const date = (fromBody ? findDate(body) : null) ?? findDate(stem);
  const merchant =
    (fromBody ? (emailSender(body) ?? merchantFromFirstLine(body)) : null) ?? merchantFromFilename(filename);
  return { totalCents, date, merchant };
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp"]);

/** OCR of a PDF's pages, for PDFs whose text layer is missing the receipt lines. null when nothing readable. */
export async function readPdfOcrText(data: Buffer): Promise<string | null> {
  try {
    const { ocrPdf } = await import("./ocr");
    return (await ocrPdf(data)) || null;
  } catch {
    return null;
  }
}
/** A PDF with less text than this is treated as a scan and sent through OCR. */
const SCANNED_PDF_CHARS = 40;

/**
 * Text from a receipt file: read directly for txt/eml and text PDFs, via local
 * OCR for photos (png, jpg, webp) and scanned PDFs. null when nothing readable.
 */
export async function readReceiptText(ext: string, data: Buffer): Promise<string | null> {
  try {
    if (ext === "txt" || ext === "eml") return data.toString("utf8").slice(0, 200_000);
    if (IMAGE_EXTS.has(ext)) {
      const { ocrImage } = await import("./ocr");
      return (await ocrImage(data)) || null;
    }
    if (ext === "pdf") {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(data));
      const { text } = await extractText(pdf, { mergePages: true });
      if (text.trim().length >= SCANNED_PDF_CHARS) return text.slice(0, 200_000);
      const { ocrPdf } = await import("./ocr");
      return (await ocrPdf(data)) || null;
    }
  } catch {
    // Unreadable or encrypted files are still stored, just without hints.
  }
  return null;
}
