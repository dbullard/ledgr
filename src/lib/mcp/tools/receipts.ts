import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { withHousehold } from "@/lib/household-context";
import { getItemSpendByCategory, getTopProducts } from "@/queries/receipt-items";
import {
  attachReceiptToTransaction,
  listUnmatchedReceipts,
  saveStructuredReceipt,
  setItemsForReceipt,
} from "@/lib/receipts/service";
import { MAX_RECEIPT_BYTES } from "@/lib/receipts/paths";
import { todayDateString } from "@/lib/date-utils";
import { READ_ANNOTATIONS, WRITE_ANNOTATIONS } from "../constants";
import { JSON_RESULT_SCHEMA, errorResult, jsonResult } from "../tool-result";

const itemSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("The item text exactly as printed on the receipt (keep abbreviations and capitals)"),
  totalCents: z.number().int().describe("Line price in integer cents ($3.49 is 349). Discounts are negative."),
  quantity: z.number().positive().optional().describe("Count or weight if printed, else omit"),
  product: z.string().optional().describe('Plain-English product name, e.g. "Bananas"'),
  category: z.string().optional().describe("One of the household's category names (see list_categories)"),
});

const ITEMS_HELP =
  "Read every purchased line from the receipt yourself. Do not skip, merge or invent lines; leave out " +
  "subtotal, tax, total, tender and loyalty lines.";

export function registerReceiptReadTools(server: McpServer, householdId: string) {
  server.registerTool(
    "get_item_spending",
    {
      title: "Get Item Spending",
      description:
        "What the household buys, from receipts that have been read item by item: spend by category and the " +
        "top products with average price per unit. Prices are before tax. Only receipts attached to a " +
        "transaction are counted.",
      inputSchema: z.object({
        dateFrom: z.string().optional().describe("Start date YYYY-MM-DD (default: 90 days ago)"),
        dateTo: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
        categoryId: z.string().optional().describe("Limit products to one category"),
        limit: z.number().int().min(1).max(100).optional().describe("Max products (default 25)"),
      }),
      outputSchema: JSON_RESULT_SCHEMA,
      annotations: READ_ANNOTATIONS,
    },
    async (args) => {
      const today = todayDateString();
      const from =
        args.dateFrom ??
        new Date(Date.parse(`${today}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
      const filters = { dateFrom: from, dateTo: args.dateTo ?? today, categoryId: args.categoryId ?? null };
      const data = await withHousehold(householdId, async (tx) => ({
        byCategory: await getItemSpendByCategory(householdId, { ...filters, categoryId: null }, tx),
        topProducts: await getTopProducts(householdId, filters, args.limit ?? 25, tx),
      }));
      return jsonResult({ dateFrom: filters.dateFrom, dateTo: filters.dateTo, ...data });
    },
  );
}

export function registerReceiptTools(server: McpServer, householdId: string) {
  server.registerTool(
    "save_receipt",
    {
      title: "Save Receipt",
      description:
        "Save a receipt you have read, with its line items, into the household's receipts folder " +
        "(<year>/<month>/<date>_<merchant>_<amount>) and attach it to the matching transaction. " +
        ITEMS_HELP +
        " If the result status is 'unmatched', show the user the returned suggestions and, once they pick one, " +
        "call attach_receipt (or call save_receipt again with transactionId). Receipts are optional and never " +
        "required for anything. If you have the original file's bytes, pass filename and contentBase64 to " +
        "store it; otherwise a text copy is saved.",
      inputSchema: z.object({
        merchant: z.string().min(1).describe("Store name as printed"),
        date: z.string().describe("Purchase date YYYY-MM-DD"),
        totalCents: z.number().int().positive().optional().describe("Grand total in integer cents"),
        taxCents: z.number().int().nonnegative().optional().describe("Tax in integer cents"),
        items: z.array(itemSchema).max(500).describe("The purchased lines"),
        transactionId: z.string().optional().describe("Attach to this transaction instead of auto-matching"),
        filename: z.string().optional().describe("Original file name, e.g. receipt.jpg (with contentBase64)"),
        contentBase64: z.string().optional().describe("The original file, base64 encoded (max 15 MB)"),
      }),
      outputSchema: JSON_RESULT_SCHEMA,
      annotations: { ...WRITE_ANNOTATIONS, idempotentHint: false },
    },
    async (args) => {
      let original: { filename: string; data: Buffer } | undefined;
      if (args.contentBase64) {
        if (!args.filename) return errorResult("filename is required with contentBase64");
        if (args.contentBase64.length > Math.ceil((MAX_RECEIPT_BYTES * 4) / 3) + 8) {
          return errorResult("File is larger than 15 MB");
        }
        original = { filename: args.filename, data: Buffer.from(args.contentBase64, "base64") };
      }
      const result = await withHousehold(householdId, (tx) =>
        saveStructuredReceipt({
          householdId,
          db: tx,
          source: "mcp",
          merchant: args.merchant,
          date: args.date,
          totalCents: args.totalCents ?? null,
          taxCents: args.taxCents ?? null,
          items: args.items,
          transactionId: args.transactionId ?? null,
          original,
        }),
      );
      if (result.status === "error") return errorResult(result.error);
      if (result.status === "duplicate") {
        return jsonResult({
          status: "duplicate",
          receiptId: result.receiptId,
          note: "This receipt was already saved. Use set_receipt_items to change its items.",
        });
      }
      return jsonResult(result);
    },
  );

  server.registerTool(
    "list_unmatched_receipts",
    {
      title: "List Unmatched Receipts",
      description:
        "Receipts that are saved but not attached to a transaction, each with likely matching transactions.",
      inputSchema: z.object({}),
      outputSchema: JSON_RESULT_SCHEMA,
      annotations: READ_ANNOTATIONS,
    },
    async () => {
      const rows = await withHousehold(householdId, (tx) => listUnmatchedReceipts(tx, householdId, 50));
      return jsonResult(
        rows.map((r) => ({
          receiptId: r.id,
          filename: r.originalFilename,
          merchant: r.hintMerchant,
          date: r.hintDate,
          totalCents: r.hintTotalCents,
          suggestions: r.suggestions,
        })),
      );
    },
  );

  server.registerTool(
    "attach_receipt",
    {
      title: "Attach Receipt",
      description: "Attach a saved, unmatched receipt to a transaction. The file is renamed to match the transaction.",
      inputSchema: z.object({
        receiptId: z.string().min(1),
        transactionId: z.string().min(1),
      }),
      outputSchema: JSON_RESULT_SCHEMA,
      annotations: WRITE_ANNOTATIONS,
    },
    async (args) => {
      const res = await withHousehold(householdId, (tx) =>
        attachReceiptToTransaction(tx, householdId, args.receiptId, args.transactionId),
      );
      return "error" in res ? errorResult(res.error) : jsonResult(res);
    },
  );

  server.registerTool(
    "set_receipt_items",
    {
      title: "Set Receipt Items",
      description:
        "Replace the line items of a saved receipt. " +
        ITEMS_HELP +
        " The household's learned product dictionary is applied on top, so a corrected product name or category wins.",
      inputSchema: z.object({
        receiptId: z.string().min(1),
        items: z.array(itemSchema).max(500),
      }),
      outputSchema: JSON_RESULT_SCHEMA,
      annotations: WRITE_ANNOTATIONS,
    },
    async (args) => {
      const res = await withHousehold(householdId, (tx) =>
        setItemsForReceipt(tx, householdId, args.receiptId, args.items),
      );
      return "error" in res ? errorResult(res.error) : jsonResult(res);
    },
  );
}
