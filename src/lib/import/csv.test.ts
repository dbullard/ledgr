import { describe, it, expect } from "vitest";
import { parsePreview, parseAll } from "./csv";
import { autoDetectMapping, validateMapping } from "./mapper";
import { normalizeImportedRows } from "./normalize";

// Shape of Arvest's online-banking export: an account banner line before the
// header, debits already negative, and a trailing totals row. Sample is made up.
const ARVEST = [
  '"Checking","******0000"',
  '"Date","Account","Description","Check #","Category","Credit","Debit"',
  '"11/03/2026","Checking","UTILITY BILL EXAMPLE","","Utilities","","-29.47"',
  '"11/02/2026","Checking","STORE RTN EXAMPLE","","Supplies","73.50",""',
  '"","","","Totals:","2 items","73.50","-29.47"',
].join("\n");

describe("bank CSV with a preamble line before the header", () => {
  it("finds the real header row instead of using the banner line", () => {
    const p = parsePreview(ARVEST);
    expect(p.headers).toEqual(["Date", "Account", "Description", "Check #", "Category", "Credit", "Debit"]);
    expect(parseAll(ARVEST)[0].Description).toBe("UTILITY BILL EXAMPLE");
  });

  it("still parses a plain CSV whose first line is the header", () => {
    const plain = "Date,Description,Amount\n2026-11-01,Coffee,-4.50\n";
    expect(parsePreview(plain).headers).toEqual(["Date", "Description", "Amount"]);
  });

  it("maps credit/debit columns and imports negative debits as expenses, credits as income", () => {
    const mapping = autoDetectMapping(parsePreview(ARVEST).headers);
    const v = validateMapping(mapping as never);
    expect(v.valid).toBe(true);
    if (!v.valid) return;
    const { rows } = normalizeImportedRows(parseAll(ARVEST), v.mapping, "a", "h", "positive_is_expense");
    // Totals row has no date/description and is dropped.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ date: "2026-11-03", amount: 2947 }); // expense: positive_is_expense
    expect(rows[1]).toMatchObject({ date: "2026-11-02", amount: -7350 }); // income
  });
});
