import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";
import { insertAccount, insertHousehold, insertTransaction } from "./helpers";
import { receipts } from "../../src/db/schema";
import type { LedgrDb } from "../../src/db";
import { createCanvas } from "@napi-rs/canvas";

let currentHousehold = "";
vi.mock("../../src/lib/auth/authorize-action", () => ({
  authorizeAction: async () => ({ householdId: currentHousehold, userId: "u1" }),
}));
vi.mock("../../src/lib/auth/session", () => ({
  getHouseholdId: async () => currentHousehold,
  getSession: async () => ({ user: { id: "u1" } }),
}));

let db: LedgrDb;
let close: () => Promise<void>;
let root: string;
let accountId: string;
let amazonId: string;
let spotifyNovId: string;
let costcoId: string;

const file = (name: string, content: string) => {
  const fd = new FormData();
  fd.set("file", new File([content], name));
  return fd;
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  root = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-match-"));
  const { householdId } = await insertHousehold(db);
  currentHousehold = householdId;
  ({ accountId } = await insertAccount(db, householdId, { name: "Card" }));
  const mk = (name: string, date: string, cents: number) =>
    insertTransaction(db, householdId, accountId, {
      date,
      name,
      originalName: name.toUpperCase(),
      amount: cents,
      normalizedAmount: -cents,
    });
  ({ transactionId: amazonId } = await mk("Amazon", "2026-11-02", 7539));
  await mk("Spotify", "2026-10-04", 2408);
  ({ transactionId: spotifyNovId } = await mk("Spotify", "2026-11-04", 2408));
  ({ transactionId: costcoId } = await mk("Costco", "2026-11-04", 12345));
  await mk("Shell", "2026-11-03", 5000);
  await mk("Chevron", "2026-11-03", 5000);
});

afterAll(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("unmatched receipts", () => {
  it("auto-attaches when one transaction clearly matches", async () => {
    const { uploadUnmatchedReceipt } = await import("../../src/actions/receipts");
    const res = await uploadUnmatchedReceipt(
      file("order.txt", "Order Placed: November 2, 2026\nGrand Total: $75.39"),
      db,
      root,
    );
    expect(res).toEqual({ status: "attached", transactionId: amazonId });
    const [row] = await db.select().from(receipts).where(eq(receipts.transactionId, amazonId));
    expect(row.filePath).toBe("2026/11/2026-11-02_amazon_75.39.txt");
    expect(row.hintTotalCents).toBe(7539);
  });

  it("picks the right month of a repeating charge", async () => {
    const { uploadUnmatchedReceipt } = await import("../../src/actions/receipts");
    const res = await uploadUnmatchedReceipt(file("spotify.eml", "From: Spotify <a@b.c>\nNov 4, 2026\nTotal $24.08"), db, root);
    expect(res).toEqual({ status: "attached", transactionId: spotifyNovId });
  });

  it("keeps an ambiguous receipt in the tray with suggestions, then attaches on request", async () => {
    const { uploadUnmatchedReceipt, fetchUnmatchedReceipts, attachReceipt } = await import("../../src/actions/receipts");
    expect(
      await uploadUnmatchedReceipt(file("gas.txt", "Date: 2026-11-03\nTotal: $50.00"), db, root),
    ).toEqual({ status: "unmatched" });

    const list = await fetchUnmatchedReceipts(db);
    if (!("data" in list)) throw new Error("expected data");
    expect(list.data).toHaveLength(1);
    expect(list.data[0].suggestions.map((s) => s.name).sort()).toEqual(["Chevron", "Shell"]);
    expect(list.data[0].hintTotalCents).toBe(5000);

    const shell = list.data[0].suggestions.find((s) => s.name === "Shell")!;
    expect(await attachReceipt(list.data[0].id, shell.transactionId, db, root)).toEqual({ success: true });
    const [row] = await db.select().from(receipts).where(eq(receipts.id, list.data[0].id));
    expect(row.transactionId).toBe(shell.transactionId);
    expect(row.filePath).toBe("2026/11/2026-11-03_shell_50.00.txt");
    await expect(fs.access(path.join(root, row.filePath))).resolves.toBeUndefined();

    expect(await attachReceipt(list.data[0].id, amazonId, db, root)).toEqual({ error: "Receipt is already attached" });
    const after = await fetchUnmatchedReceipts(db);
    expect("data" in after && after.data).toHaveLength(0);
  });

  it("reports duplicates instead of storing twice", async () => {
    const { uploadUnmatchedReceipt } = await import("../../src/actions/receipts");
    expect(
      await uploadUnmatchedReceipt(file("gas-again.txt", "Date: 2026-11-03\nTotal: $50.00"), db, root),
    ).toEqual({ status: "duplicate" });
  });
});

describe("photos", () => {
  it("OCRs a JPG receipt and attaches it like a text one", async () => {
    const { uploadUnmatchedReceipt } = await import("../../src/actions/receipts");
    const canvas = createCanvas(600, 300);
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 600, 300);
    g.fillStyle = "#000";
    g.font = "bold 40px sans-serif";
    g.fillText("COSTCO", 200, 60);
    g.font = "28px sans-serif";
    g.fillText("Date: 2026-11-04", 40, 140);
    g.fillText("Grand Total: $123.45", 40, 200);
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array(canvas.toBuffer("image/jpeg", 90))], "IMG_0042.jpg", { type: "image/jpeg" }));
    expect(await uploadUnmatchedReceipt(fd, db, root)).toEqual({ status: "attached", transactionId: costcoId });
    const [row] = await db.select().from(receipts).where(eq(receipts.transactionId, costcoId));
    expect(row.filePath).toBe("2026/11/2026-11-04_costco_123.45.jpg");
    expect(row.hintTotalCents).toBe(12345);
  }, 90_000);

  it("falls back to the vision model for total, date and merchant, only when a local model is set", async () => {
    vi.resetModules();
    vi.doMock("../../src/lib/receipts/parse-model", () => ({
      receiptModelBlocker: () => null,
      runReceiptModel: async () => ({ items: [], totalCents: 4200, date: "Nov 4, 2026", merchant: " Costco " }),
    }));
    const { visionHints } = await import("../../src/lib/receipts/ingest");
    expect(await visionHints("jpg", Buffer.from("x"))).toEqual({ totalCents: 4200, date: "2026-11-04", merchant: "Costco" });
    expect(await visionHints("jpg", Buffer.from("x"), "no local model")).toEqual({});
    expect(await visionHints("txt", Buffer.from("x"))).toEqual({});
    vi.doUnmock("../../src/lib/receipts/parse-model");
    vi.resetModules();
  });
});

describe("inbox folder", () => {
  it("ingests settled files, skips fresh ones and unsupported types", async () => {
    const { scanReceiptInbox } = await import("../../src/lib/receipts/inbox");
    const inbox = path.join(root, "inbox");
    await fs.mkdir(inbox, { recursive: true });
    await fs.writeFile(path.join(inbox, "Lunch 2026-11-05 12.34.txt"), "Total 12.34");
    await fs.writeFile(path.join(inbox, "notes.docx"), "x");
    await fs.writeFile(path.join(inbox, "dupe.txt"), "Date: 2026-11-03\nTotal: $50.00");

    const tooSoon = await scanReceiptInbox({ db, root, now: Date.now() });
    expect(tooSoon).toEqual({ stored: 0, attached: 0, duplicates: 0, skipped: 0 });

    const res = await scanReceiptInbox({ db, root, now: Date.now() + 60_000 });
    expect(res).toEqual({ stored: 1, attached: 0, duplicates: 1, skipped: 1 });
    expect(await fs.readdir(inbox)).toEqual(["_skipped"]);

    const [row] = await db.select().from(receipts).where(eq(receipts.source, "folder"));
    expect(row.hintTotalCents).toBe(1234);
    expect(row.transactionId).toBeNull();
  });
});
