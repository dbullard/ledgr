import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";
import {
  insertAccount,
  insertCategory,
  insertCategoryGroup,
  insertHousehold,
  insertTransaction,
} from "./helpers";
import { receipts } from "../../src/db/schema";
import type { LedgrDb } from "../../src/db";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../../src/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, get db() { return holder.db; } };
});

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  structuredContent?: { data: Record<string, unknown> & unknown[] };
  content: { text: string }[];
}>;

function tools(householdId: string, scope: "write" | "read" = "write") {
  const handlers: Record<string, Handler> = {};
  const fake = { registerTool: (name: string, _c: unknown, fn: Handler) => { handlers[name] = fn; } };
  return import("../../src/lib/mcp/tools/receipts").then((m) => {
    m.registerReceiptReadTools(fake as never, householdId);
    if (scope === "write") m.registerReceiptTools(fake as never, householdId);
    return handlers;
  });
}

let db: LedgrDb;
let close: () => Promise<void>;
let root: string;
let hh: string;
let other: string;
let amazonId: string;
let grocId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  holder.db = db;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-receipts-"));
  process.env.RECEIPTS_DIR = root;
  ({ householdId: hh } = await insertHousehold(db));
  ({ householdId: other } = await insertHousehold(db, "Other"));
  const { accountId } = await insertAccount(db, hh, { name: "Card" });
  const { groupId } = await insertCategoryGroup(db, hh, { name: "Spending" });
  ({ categoryId: grocId } = await insertCategory(db, hh, groupId, { name: "Groceries" }));
  const mk = async (name: string, date: string, cents: number) =>
    (await insertTransaction(db, hh, accountId, { date, name, originalName: name, amount: cents, normalizedAmount: -cents })).transactionId;
  amazonId = await mk("Amazon", "2026-11-02", 7539);
  await mk("Shell", "2026-11-03", 5000);
  await mk("Chevron", "2026-11-03", 5000);
});

afterAll(async () => {
  delete process.env.RECEIPTS_DIR;
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("MCP receipt tools", () => {
  it("saves a receipt Claude read, attaches it, files it and stores items", async () => {
    const t = await tools(hh);
    const res = await t.save_receipt({
      merchant: "Amazon",
      date: "2026-11-02",
      totalCents: 7539,
      items: [
        { name: "KS ORG BNNA", totalCents: 349, product: "Bananas", category: "Groceries" },
        { name: "MILK 1GAL", totalCents: 399, category: "Groceries" },
      ],
    });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent!.data).toMatchObject({ status: "attached", transactionId: amazonId, itemCount: 2 });
    const [row] = await db.select().from(receipts).where(eq(receipts.transactionId, amazonId));
    expect(row.source).toBe("mcp");
    expect(row.filePath).toBe("2026/11/2026-11-02_amazon_75.39.txt");
    expect((await fs.readFile(path.join(root, row.filePath), "utf8"))).toContain("KS ORG BNNA");
  });

  it("reports a duplicate instead of saving twice", async () => {
    const t = await tools(hh);
    const res = await t.save_receipt({
      merchant: "Amazon",
      date: "2026-11-02",
      totalCents: 7539,
      items: [
        { name: "KS ORG BNNA", totalCents: 349, product: "Bananas", category: "Groceries" },
        { name: "MILK 1GAL", totalCents: 399, category: "Groceries" },
      ],
    });
    expect(res.structuredContent!.data.status).toBe("duplicate");
  });

  it("leaves an ambiguous receipt unmatched with suggestions, then attaches it", async () => {
    const t = await tools(hh);
    const saved = await t.save_receipt({
      merchant: "Fuel",
      date: "2026-11-03",
      totalCents: 5000,
      items: [{ name: "UNLEADED", totalCents: 5000 }],
    });
    const data = saved.structuredContent!.data as unknown as { status: string; receiptId: string; suggestions: { transactionId: string; name: string }[] };
    expect(data.status).toBe("unmatched");
    expect(data.suggestions.map((s) => s.name).sort()).toEqual(["Chevron", "Shell"]);

    const listed = await t.list_unmatched_receipts({});
    expect((listed.structuredContent!.data as unknown as unknown[]).length).toBe(1);

    const shell = data.suggestions.find((s) => s.name === "Shell")!;
    const att = await t.attach_receipt({ receiptId: data.receiptId, transactionId: shell.transactionId });
    expect(att.isError).toBeUndefined();
    const [row] = await db.select().from(receipts).where(eq(receipts.id, data.receiptId));
    expect(row.filePath).toBe("2026/11/2026-11-03_shell_50.00.txt");
  });

  it("stores the original file when bytes are supplied", async () => {
    const t = await tools(hh);
    const bytes = Buffer.from("\xff\xd8\xff\xe0fake-jpeg-bytes-for-test", "latin1");
    const res = await t.save_receipt({
      merchant: "Costco",
      date: "2026-11-04",
      totalCents: 12345,
      items: [{ name: "TP", totalCents: 12345 }],
      filename: "IMG_1.jpg",
      contentBase64: bytes.toString("base64"),
    });
    const data = res.structuredContent!.data as unknown as { receiptId: string };
    const [row] = await db.select().from(receipts).where(eq(receipts.id, data.receiptId));
    expect(row.filePath).toMatch(/^\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}_unmatched_[0-9a-f]{8}\.jpg$/);
    expect(row.contentType).toBe("image/jpeg");
    expect((await fs.readFile(path.join(root, row.filePath))).equals(bytes)).toBe(true);
    expect((await t.save_receipt({ merchant: "X", date: "2026-11-04", items: [], contentBase64: "AAAA" })).isError).toBe(true);
  });

  it("replaces items and applies categories; another household cannot touch it", async () => {
    const t = await tools(hh);
    const [row] = await db.select().from(receipts).where(eq(receipts.transactionId, amazonId));
    const res = await t.set_receipt_items({ receiptId: row.id, items: [{ name: "EGGS", totalCents: 500, category: "groceries" }] });
    expect(res.structuredContent!.data).toEqual({ itemCount: 1 });

    const foreign = await (await tools(other)).set_receipt_items({ receiptId: row.id, items: [{ name: "X", totalCents: 1 }] });
    expect(foreign.isError).toBe(true);
    const foreignAttach = await (await tools(other)).attach_receipt({ receiptId: row.id, transactionId: amazonId });
    expect(foreignAttach.isError).toBe(true);
  });

  it("reports item spending", async () => {
    const t = await tools(hh, "read");
    expect(t.save_receipt).toBeUndefined();
    const res = await t.get_item_spending({ dateFrom: "2026-10-01", dateTo: "2026-11-30" });
    const data = res.structuredContent!.data as unknown as { byCategory: { categoryId: string; totalCents: number }[]; topProducts: { name: string }[] };
    expect(data.byCategory.find((c) => c.categoryId === grocId)?.totalCents).toBe(500);
    expect(data.topProducts.map((p) => p.name)).toContain("EGGS");
  });
});
