import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb } from "./setup";
import { insertHousehold, insertAccount, insertTransaction, insertCategoryGroup, insertCategory } from "./helpers";
import { collectCandidates } from "../../src/lib/push/scan";
import { getPushScanSettings } from "../../src/lib/push/scan-settings";
import type { LedgrDb } from "../../src/db";

// A Sunday morning, so the weekly digest is due.
const SUNDAY = new Date(2026, 10, 8, 9, 30);
const day = (n: number) => `2026-11-${String(n).padStart(2, "0")}`;

describe("weekly digest: review backlog", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;
  let householdId: string;
  let accountId: string;
  let categoryId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    ({ householdId } = await insertHousehold(db));
    ({ accountId } = await insertAccount(db, householdId));
    const { groupId } = await insertCategoryGroup(db, householdId);
    ({ categoryId } = await insertCategory(db, householdId, groupId, { name: "Gas" }));
  });
  afterAll(async () => {
    await close();
  });

  const settings = () => {
    const s = getPushScanSettings({});
    return { ...s, types: { ...s.types, weekly: true } };
  };
  const add = (o: Parameters<typeof insertTransaction>[3]) =>
    insertTransaction(db, householdId, accountId, { date: day(5), amount: 1000, normalizedAmount: -1000, ...o });

  it("counts unreviewed uncategorized and guessed rows, not trusted or reviewed ones", async () => {
    // Waiting for review: no category, or a category that is only a guess.
    await add({ name: "uncategorized" });
    await add({ name: "ai guess", categoryId, categorySource: "ai" });
    await add({ name: "history guess", categoryId, categorySource: "history" });
    // Not waiting: a decision was made, or it is not a real, settled charge.
    await add({ name: "manual", categoryId, categorySource: "manual" });
    await add({ name: "rule", categoryId, categorySource: "rule" });
    await add({ name: "reviewed uncategorized", reviewed: true });
    await add({ name: "reviewed guess", categoryId, categorySource: "history", reviewed: true });
    await add({ name: "pending", pending: true });
    await add({ name: "hidden", isHidden: true });
    await add({ name: "transfer", isTransfer: true });

    const { candidates } = await collectCandidates(householdId, db, SUNDAY, settings());
    const weekly = candidates.find((c) => c.type === "weekly");
    expect(weekly?.message.body).toContain("3 to review");
  });

  it("omits the line when nothing is waiting", async () => {
    const { householdId: clean } = await insertHousehold(db);
    const { accountId: acct } = await insertAccount(db, clean);
    await insertTransaction(db, clean, acct, { date: day(5), amount: 1000, normalizedAmount: -1000, reviewed: true });

    const { candidates } = await collectCandidates(clean, db, SUNDAY, settings());
    const weekly = candidates.find((c) => c.type === "weekly");
    expect(weekly).toBeDefined();
    expect(weekly!.message.body).not.toContain("review");
  });
});
