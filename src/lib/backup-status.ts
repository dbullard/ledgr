import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseBackupStatus, type BackupStatus } from "@/lib/data-health";

/** Where the backup sidecar's volume is mounted (read-only) inside the app container. */
export function backupDir(): string {
  return process.env.LEDGR_BACKUP_DIR || "/backups";
}

/**
 * The backup sidecar's latest status, or null when no sidecar is set up (no
 * mount, no file) or the file is unreadable. The app never writes backups; it
 * only reports on them.
 */
export async function readBackupStatus(dir: string = backupDir()): Promise<BackupStatus | null> {
  try {
    return parseBackupStatus(await readFile(path.join(dir, "status.json"), "utf8"));
  } catch {
    return null;
  }
}
