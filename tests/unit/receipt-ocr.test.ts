import { describe, expect, test } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { ocrImage, ocrPdf } from "../../src/lib/receipts/ocr";
import { extractHints } from "../../src/lib/receipts/hints";

const W = 600;
const H = 500;

/** A receipt-like image: store name on top, a few lines, a total. */
function receiptCanvas() {
  const canvas = createCanvas(W, H);
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#000";
  g.font = "bold 40px sans-serif";
  g.fillText("TRADER JOES", 150, 60);
  g.font = "28px sans-serif";
  const lines = ["Order Placed: Oct 27, 2026", "ORG BNNA          1.38", "2% MILK GAL       4.29", "Subtotal          5.67", "Grand Total: $74.33"];
  lines.forEach((l, i) => g.fillText(l, 40, 130 + i * 55));
  return canvas;
}

/** A one-page PDF whose only content is a JPEG, i.e. a scan with no text layer. */
function scannedPdf(jpeg: Buffer): Buffer {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let len = 0;
  const add = (b: Buffer | string) => {
    const buf = typeof b === "string" ? Buffer.from(b, "latin1") : b;
    parts.push(buf);
    len += buf.length;
  };
  const obj = (n: number, body: Buffer | string) => {
    offsets[n] = len;
    add(`${n} 0 obj\n`);
    add(body);
    add("\nendobj\n");
  };
  add("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  obj(4, Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, "latin1"),
    jpeg,
    Buffer.from("\nendstream", "latin1"),
  ]));
  const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = len;
  add(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => String(offsets[n]).padStart(10, "0") + " 00000 n \n").join("")}`);
  add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return Buffer.concat(parts);
}

describe("receipt OCR", () => {
  test("reads a photo and yields the same hints a text receipt would", async () => {
    const jpeg = receiptCanvas().toBuffer("image/jpeg", 90);
    const text = await ocrImage(jpeg);
    const hints = extractHints("IMG_4821.jpg", text);
    expect(hints.totalCents).toBe(7433);
    expect(hints.date).toBe("2026-10-27");
    expect(hints.merchant?.toLowerCase()).toContain("trader");
  }, 90_000);

  test("reads a scanned PDF with no text layer", async () => {
    const pdf = scannedPdf(receiptCanvas().toBuffer("image/jpeg", 90));
    const text = await ocrPdf(pdf);
    expect(extractHints("scan.pdf", text).totalCents).toBe(7433);
  }, 90_000);

  test("returns empty text, without crashing, for files that are not readable images", async () => {
    expect(await ocrImage(Buffer.from("not an image at all"))).toBe("");
    const truncated = receiptCanvas().toBuffer("image/jpeg", 90).subarray(0, 600);
    expect(typeof (await ocrImage(truncated))).toBe("string");
    // the worker still works afterwards
    expect((await ocrImage(receiptCanvas().toBuffer("image/png"))).length).toBeGreaterThan(20);
  }, 90_000);
});
