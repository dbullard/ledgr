import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildReceiptRelPath,
  receiptExtension,
  resolveReceiptPath,
  receiptsRoot,
  slugify,
} from "../../src/lib/receipts/paths";
import { writeReceipt, moveReceipt, deleteReceiptFile, sha256Hex } from "../../src/lib/receipts/storage";

describe("receipt paths", () => {
  test("builds year/month folder with date, merchant and amount", () => {
    expect(
      buildReceiptRelPath({ date: "2026-11-02", merchant: "Amazon", amountCents: 7539, ext: "pdf" }),
    ).toBe("2026/11/2026-11-02_amazon_75.39.pdf");
  });

  test("pads cents and uses absolute amount", () => {
    expect(
      buildReceiptRelPath({ date: "2026-01-05", merchant: "Casey's", amountCents: -2605, ext: "jpg" }),
    ).toBe("2026/01/2026-01-05_casey-s_26.05.jpg");
  });

  test("unmatched receipts use a hash and collisions add a suffix", () => {
    expect(buildReceiptRelPath({ date: "2026-11-06", ext: "png", hash: "abcdef1234567890" })).toBe(
      "2026/11/2026-11-06_unmatched_abcdef12.png",
    );
    expect(
      buildReceiptRelPath({ date: "2026-11-02", merchant: "Amazon", amountCents: 100, ext: "pdf", attempt: 2 }),
    ).toBe("2026/11/2026-11-02_amazon_1.00-2.pdf");
  });

  test("rejects bad dates and types", () => {
    expect(() => buildReceiptRelPath({ date: "11/02/2026", ext: "pdf" })).toThrow();
    expect(() => buildReceiptRelPath({ date: "2026-11-02", ext: "exe" })).toThrow();
  });

  test("allow-lists extensions case-insensitively", () => {
    expect(receiptExtension("Scan.PDF")).toBe("pdf");
    expect(receiptExtension("run.exe")).toBeNull();
    expect(receiptExtension("noext")).toBeNull();
  });

  test("slugify strips path characters and accents", () => {
    expect(slugify("../../Étoile/Café")).toBe("etoile-cafe");
    expect(slugify("///")).toBe("unknown");
  });

  test("resolveReceiptPath refuses traversal", () => {
    const root = path.resolve("/tmp/receipts-root");
    expect(resolveReceiptPath("2026/11/a.pdf", root)).toBe(path.join(root, "2026/11/a.pdf"));
    expect(() => resolveReceiptPath("../etc/passwd", root)).toThrow();
    expect(() => resolveReceiptPath("/etc/passwd", root)).toThrow();
  });

  test("root comes from RECEIPTS_DIR, else the data dir", () => {
    expect(receiptsRoot({ RECEIPTS_DIR: "/mnt/nas/receipts" })).toBe("/mnt/nas/receipts");
    expect(receiptsRoot({ LEDGR_DATA_DIR: "/data" })).toBe("/data/receipts");
  });
});

describe("receipt storage", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "receipts-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("writes without overwriting and numbers collisions", async () => {
    const parts = { date: "2026-11-02", merchant: "Amazon", amountCents: 7539, ext: "pdf" };
    const a = await writeReceipt(Buffer.from("one"), parts, root);
    const b = await writeReceipt(Buffer.from("two"), parts, root);
    expect(a).toBe("2026/11/2026-11-02_amazon_75.39.pdf");
    expect(b).toBe("2026/11/2026-11-02_amazon_75.39-2.pdf");
    expect((await fs.readFile(path.join(root, a))).toString()).toBe("one");
  });

  test("moves a receipt to its attached name", async () => {
    const from = await writeReceipt(Buffer.from("x"), { date: "2026-11-06", ext: "pdf", hash: "deadbeefcafe" }, root);
    const to = await moveReceipt(from, { date: "2026-11-02", merchant: "Amazon", amountCents: 7539, ext: "pdf" }, root);
    expect(to).toBe("2026/11/2026-11-02_amazon_75.39.pdf");
    await expect(fs.access(path.join(root, from))).rejects.toThrow();
    expect((await fs.readFile(path.join(root, to))).toString()).toBe("x");
  });

  test("delete is idempotent", async () => {
    const rel = await writeReceipt(Buffer.from("x"), { date: "2026-11-06", ext: "txt" }, root);
    await deleteReceiptFile(rel, root);
    await deleteReceiptFile(rel, root);
    await expect(fs.access(path.join(root, rel))).rejects.toThrow();
  });

  test("sha256Hex is stable", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
