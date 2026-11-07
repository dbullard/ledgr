import { eq } from "drizzle-orm";
import { db as defaultDb, type LedgrDb } from "@/db";
import { pushPreferences } from "@/db/schema";
import { withHousehold } from "@/lib/household-context";
import { getPushScanSettings, type PushScanSettings } from "./scan-settings";

/** What the settings screen shows and edits. Always fully resolved (no nulls). */
export interface PushPreferences {
  /** Master switch for everything below. */
  enabled: boolean;
  deposits: boolean;
  /** Deposits at or above this many cents are announced. */
  depositCents: number;
  /** Daily nudge when several transactions still need a category. */
  review: boolean;
  /** Sunday-morning recap of the week. */
  weekly: boolean;
  bills: boolean;
  largeCharges: boolean;
  budgets: boolean;
  connections: boolean;
  lowBalance: boolean;
  /** Checking/savings balances under this many cents trigger an alert. */
  lowBalanceCents: number;
  /** Charges at or above this many cents count as large. */
  largeChargeCents: number;
  quietEnabled: boolean;
  quietStartHour: number;
  quietEndHour: number;
}

export type PushPreferencesPatch = Partial<PushPreferences>;

const hour = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23 ? v : null;

/** Validates untrusted input; returns null if any provided field is invalid. */
export function parsePreferencesPatch(raw: unknown): PushPreferencesPatch | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const out: PushPreferencesPatch = {};
  for (const k of ["enabled", "bills", "largeCharges", "budgets", "connections", "lowBalance", "deposits", "review", "weekly", "quietEnabled"] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "boolean") return null;
    out[k] = b[k] as boolean;
  }
  if (b.largeChargeCents !== undefined) {
    const n = b.largeChargeCents;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 100 || n > 100_000_000) return null;
    out.largeChargeCents = n;
  }
  if (b.depositCents !== undefined) {
    const n = b.depositCents;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 100 || n > 100_000_000) return null;
    out.depositCents = n;
  }
  if (b.lowBalanceCents !== undefined) {
    const n = b.lowBalanceCents;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 100_000_000) return null;
    out.lowBalanceCents = n;
  }
  for (const k of ["quietStartHour", "quietEndHour"] as const) {
    if (b[k] === undefined) continue;
    const h = hour(b[k]);
    if (h === null) return null;
    out[k] = h;
  }
  return out;
}

export async function getPushPreferences(
  householdId: string,
  db: LedgrDb = defaultDb,
  env: Record<string, string | undefined> = process.env,
): Promise<PushPreferences> {
  const [row] = await withHousehold(
    householdId,
    (tx) => tx.select().from(pushPreferences).where(eq(pushPreferences.householdId, householdId)).limit(1),
    db,
  );
  const base = getPushScanSettings(env);
  return {
    enabled: row?.enabled ?? true,
    deposits: row?.deposits ?? false,
    depositCents: row?.depositCents ?? 50_000,
    review: row?.review ?? false,
    weekly: row?.weekly ?? false,
    bills: row?.bills ?? true,
    largeCharges: row?.largeCharges ?? true,
    budgets: row?.budgets ?? true,
    connections: row?.connections ?? true,
    lowBalance: row?.lowBalance ?? false,
    lowBalanceCents: row?.lowBalanceCents ?? 10_000,
    largeChargeCents: row?.largeChargeCents ?? base.largeTxnCents,
    quietEnabled: row?.quietEnabled ?? true,
    quietStartHour: row?.quietStartHour ?? base.quietStartHour,
    quietEndHour: row?.quietEndHour ?? base.quietEndHour,
  };
}

export async function updatePushPreferences(
  householdId: string,
  patch: PushPreferencesPatch,
  db: LedgrDb = defaultDb,
): Promise<PushPreferences> {
  const values = { ...patch, updatedAt: new Date() };
  await withHousehold(
    householdId,
    (tx) =>
      tx
        .insert(pushPreferences)
        .values({ householdId, ...values })
        .onConflictDoUpdate({ target: pushPreferences.householdId, set: values }),
    db,
  );
  return getPushPreferences(householdId, db);
}

/** Folds a household's saved choices into the scan settings. */
export function applyPreferences(base: PushScanSettings, p: PushPreferences): PushScanSettings {
  return {
    ...base,
    largeTxnCents: p.largeChargeCents,
    quietStartHour: p.quietStartHour,
    quietEndHour: p.quietEnabled ? p.quietEndHour : p.quietStartHour, // equal hours = no quiet window
    lowBalanceCents: p.lowBalanceCents,
    depositCents: p.depositCents,
    enabled: p.enabled,
    types: {
      bills: p.bills,
      largeCharges: p.largeCharges,
      budgets: p.budgets,
      connections: p.connections,
      lowBalance: p.lowBalance,
      deposits: p.deposits,
      review: p.review,
      weekly: p.weekly,
    },
  };
}
