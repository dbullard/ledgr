import * as cron from "node-cron";

export type SchedulerConfig = {
  enabled: boolean;
  snapshotCron: string;
  safetySyncCron: string;
  simplefinSyncCron: string;
  receiptInboxCron: string;
};

const DEFAULTS = {
  snapshotCron: "15 3 * * *",
  safetySyncCron: "30 4 * * *",
  // Every 6h, offset 15 minutes from the Plaid safety-sync. SimpleFIN has no
  // webhooks, so a once-a-day poll leaves data up to a day old.
  simplefinSyncCron: "45 */6 * * *",
  receiptInboxCron: "*/10 * * * *",
} as const;

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return true;
}

function validateCron(envName: string, expr: string): string {
  if (!cron.validate(expr)) {
    throw new Error(
      `[scheduler] ${envName} is not a valid cron expression: "${expr}"`,
    );
  }
  return expr;
}

export function getSchedulerConfig(): SchedulerConfig {
  return {
    enabled: readBool(process.env.SCHEDULER_ENABLED, true),
    snapshotCron: validateCron(
      "SCHEDULER_SNAPSHOT_CRON",
      process.env.SCHEDULER_SNAPSHOT_CRON ?? DEFAULTS.snapshotCron,
    ),
    safetySyncCron: validateCron(
      "SCHEDULER_SAFETY_SYNC_CRON",
      process.env.SCHEDULER_SAFETY_SYNC_CRON ?? DEFAULTS.safetySyncCron,
    ),
    simplefinSyncCron: validateCron(
      "SCHEDULER_SIMPLEFIN_SYNC_CRON",
      process.env.SCHEDULER_SIMPLEFIN_SYNC_CRON ?? DEFAULTS.simplefinSyncCron,
    ),
    receiptInboxCron: validateCron(
      "SCHEDULER_RECEIPT_INBOX_CRON",
      process.env.SCHEDULER_RECEIPT_INBOX_CRON ?? DEFAULTS.receiptInboxCron,
    ),
  };
}
