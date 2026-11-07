import { itemsFromText, type ParsedReceipt } from "./items";
import { readPdfOcrText } from "./hints";

/**
 * The items for a newly stored receipt, with no model needed: the device's own
 * reading if it sent one, else lines printed in the file's text. A PDF whose text
 * layer has no item lines (a printed email, a scan) is read with OCR and tried again.
 */
export async function autoItems(opts: {
  ext: string;
  data: Buffer;
  text: string | null;
  onDevice: ParsedReceipt | null;
  defaultCategory?: string | null;
}): Promise<ParsedReceipt["items"]> {
  const items = itemsFromText(opts.text, opts.onDevice, opts.defaultCategory);
  if (items.length > 0 || opts.ext !== "pdf") return items;
  const ocr = await readPdfOcrText(opts.data);
  return ocr ? itemsFromText(ocr, opts.onDevice, opts.defaultCategory) : [];
}
