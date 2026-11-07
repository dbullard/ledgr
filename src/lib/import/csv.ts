import Papa from "papaparse";

export interface CsvPreview {
  headers: string[];
  rows: Record<string, string>[];
  delimiter: string;
  totalRows: number;
}

const HEADER_DATE = /^(transaction |posted? |post |posting )?date$/i;

/**
 * Some banks put an account banner ("Checking","******1234") above the real
 * header row. Drop leading lines until the row that has a Date column and at
 * least two other cells, so the banner is not mistaken for the header.
 */
function stripPreamble(content: string): string {
  const head = Papa.parse<string[]>(content, { preview: 15, skipEmptyLines: true }).data;
  const idx = head.findIndex(
    (cells) => cells.filter((c) => c.trim() !== "").length >= 3 && cells.some((c) => HEADER_DATE.test(c.trim())),
  );
  if (idx <= 0) return content;
  const lines = content.split(/\r?\n/);
  // Preamble rows are single physical lines in practice; count non-empty lines.
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (seen === idx) return lines.slice(i).join("\n");
    seen++;
  }
  return content;
}

export function parsePreview(rawContent: string): CsvPreview {
  const content = stripPreamble(rawContent);
  const result = Papa.parse<Record<string, string>>(content, {
    header: true,
    preview: 10,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const fullCount = Papa.parse(content, { header: true, skipEmptyLines: true });

  return {
    headers: result.meta.fields ?? [],
    rows: result.data,
    delimiter: result.meta.delimiter,
    totalRows: fullCount.data.length,
  };
}

export function parseAll(rawContent: string): Record<string, string>[] {
  const content = stripPreamble(rawContent);
  const result = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  return result.data;
}
