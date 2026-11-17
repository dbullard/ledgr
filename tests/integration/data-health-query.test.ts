import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v4 as uuid } from "uuid";
import { createTestDb } from "./setup";
import { insertHousehold } from "./helpers";
import { bankConnections, syncLog } from "../../src/db/schema";
import { getConnectionHealth } from "../../src/queries/data-health";
import type { LedgrDb } from "../../src/db";

const NOW = new Date("2026-11-17T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("getConnectionHealth", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;
  let householdId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    ({ householdId } = await insertHousehold(db));
  });
  afterAll(async () => {
    await close();
  });

  async function addConnection(name: string, overrides: Partial<typeof bankConnections.$inferInsert> = {}, hh = householdId) {
    const id = uuid();
    await db.insert(bankConnections).values({
      id, householdId: hh, provider: "plaid", credential: "x", institutionName: name, status: "active", ...overrides,
    });
    return id;
  }
  const log = (connectionId: string, syncedAt: Date, error?: string) =>
    db.insert(syncLog).values({ id: uuid(), connectionId, syncedAt, error: error ?? null });

  it("judges each connection by its newest sync, not an older one", async () => {
    const id = await addConnection("Arvest");
    await log(id, hoursAgo(100), "OLD_FAILURE");
    await log(id, hoursAgo(2));

    const row = (await getConnectionHealth(householdId, NOW, db)).find((r) => r.connectionId === id)!;
    expect(row.lastSyncAt).toEqual(hoursAgo(2));
    expect(row.health).toEqual({ level: "ok", summary: "Up to date" });
  });

  it("surfaces a failed newest sync and sorts problems first", async () => {
    const failing = await addConnection("Alpha Bank");
    await log(failing, hoursAgo(1), "RATE_LIMIT");
    const revoked = await addConnection("Zeta Credit", { status: "revoked" });
    await log(revoked, hoursAgo(1));

    const rows = await getConnectionHealth(householdId, NOW, db);
    expect(rows[0].connectionId).toBe(revoked);
    expect(rows[0].health.level).toBe("problem");
    const alpha = rows.find((r) => r.connectionId === failing)!;
    expect(alpha.health).toMatchObject({ level: "warning" });
    expect(alpha.health.summary).toContain("RATE_LIMIT");
    expect(rows.map((r) => r.health.level)).toEqual([...rows.map((r) => r.health.level)].sort(
      (a, b) => ({ problem: 0, warning: 1, ok: 2 }[a]! - { problem: 0, warning: 1, ok: 2 }[b]!),
    ));
  });

  it("reports a connection that never synced", async () => {
    const id = await addConnection("Brand New");
    const row = (await getConnectionHealth(householdId, NOW, db)).find((r) => r.connectionId === id)!;
    expect(row.lastSyncAt).toBeNull();
    expect(row.health.summary).toBe("Never synced");
  });

  it("never returns another household's connections", async () => {
    const { householdId: other } = await insertHousehold(db);
    const theirs = await addConnection("Their Bank", {}, other);

    expect((await getConnectionHealth(householdId, NOW, db)).some((r) => r.connectionId === theirs)).toBe(false);
    expect((await getConnectionHealth(other, NOW, db)).map((r) => r.connectionId)).toEqual([theirs]);
  });

  it("returns an empty list for a household with no connections", async () => {
    const { householdId: empty } = await insertHousehold(db);
    expect(await getConnectionHealth(empty, NOW, db)).toEqual([]);
  });
});
