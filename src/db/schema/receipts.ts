import { index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { households } from "./households";
import { categories } from "./categories";
import { transactions } from "./transactions";

/**
 * A receipt file stored on disk (the household's NAS, see lib/receipts). Always
 * optional: nothing in Ledgr requires one. A receipt may exist with no
 * transaction (the unmatched tray) and a transaction may have several.
 * Deleting the transaction keeps the file and makes it unmatched.
 */
export const receipts = pgTable(
  "receipts",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    /** Path relative to the receipts root; never absolute. */
    filePath: text("file_path").notNull(),
    originalFilename: text("original_filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    source: text("source", { enum: ["upload", "folder", "email", "extension"] })
      .notNull()
      .default("upload"),
    /**
     * Best-effort guesses read from the file (text, email headers, filename)
     * and used only to suggest or auto-attach a transaction. NULL when nothing
     * could be read; images need OCR, which arrives with item parsing.
     */
    hintTotalCents: integer("hint_total_cents"),
    hintDate: text("hint_date"),
    hintMerchant: text("hint_merchant"),
    /** When line items were last parsed from the file; NULL if never. */
    parsedAt: timestamp("parsed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_receipts_txn").on(table.transactionId),
    uniqueIndex("idx_receipts_household_sha").on(table.householdId, table.sha256),
  ],
);

/** One purchased line on a receipt. Money is integer cents. */
export const receiptItems = pgTable(
  "receipt_items",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    receiptId: text("receipt_id")
      .notNull()
      .references(() => receipts.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    /** Exactly as printed on the receipt, e.g. "KS ORG BNNA 3LB". */
    rawName: text("raw_name").notNull(),
    /** Canonical product ("Bananas"); from the household dictionary or the model. */
    productName: text("product_name"),
    categoryId: text("category_id").references(() => categories.id, { onDelete: "set null" }),
    /** Quantity in thousandths (1000 = 1 each, 1500 = 1.5 lb). */
    quantityMilli: integer("quantity_milli").notNull().default(1000),
    totalCents: integer("total_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_receipt_items_receipt").on(table.receiptId),
    index("idx_receipt_items_household_product").on(table.householdId, table.productName),
  ],
);

/**
 * The household's learned product dictionary: what a receipt's raw text means.
 * Rows are created when the user corrects an item, so they are always confirmed.
 */
export const productAliases = pgTable(
  "product_aliases",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    /** Normalized raw name (see normalizeRawName). */
    rawKey: text("raw_key").notNull(),
    productName: text("product_name"),
    categoryId: text("category_id").references(() => categories.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("idx_product_aliases_household_key").on(table.householdId, table.rawKey)],
);
