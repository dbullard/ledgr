import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readBackupStatus } from "./backup-status";

describe("readBackupStatus", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ledgr-backup-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads status.json written by the sidecar", async () => {
    await writeFile(
      path.join(dir, "status.json"),
      JSON.stringify({ lastSuccessAt: "2026-11-17T03:00:12Z", lastAttemptAt: "2026-11-17T03:00:00Z", file: "a.dump", sizeBytes: 10, count: 2 }),
    );
    expect(await readBackupStatus(dir)).toMatchObject({ file: "a.dump", count: 2, lastError: null });
  });

  it("returns null when the directory or file is missing", async () => {
    expect(await readBackupStatus(dir)).toBeNull();
    expect(await readBackupStatus(path.join(dir, "nope"))).toBeNull();
  });

  it("returns null for a corrupt file", async () => {
    await writeFile(path.join(dir, "status.json"), "{broken");
    expect(await readBackupStatus(dir)).toBeNull();
  });
});
