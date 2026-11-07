import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { db as defaultDb, type LedgrDb } from "@/db";
import { bankConnections, households, pushEvents, transactions } from "@/db/schema";
import { withHousehold } from "@/lib/household-context";
import { getBudgetForMonth, type BudgetMonth } from "@/queries/budgets";
import { getUpcomingBills, type BillRow } from "@/queries/recurring";
import { describeConnectionIssue } from "@/lib/connection-issue";
import { getCurrentMonth } from "@/lib/date-utils";
import { centsToDisplay } from "@/lib/money";
import { getApnsConfig, type PushMessage } from "./apns";
import { listDevices } from "./devices";
import { notifyHousehold } from "./notify";

/**
 * Periodic scan that turns Ledgr state into push notifications:
 *   - bills due today or tomorrow
 *   - large new charges
 *   - budget categories passing 80% / 100%
 *   - bank connections that need attention
 *
 * Each notification has a stable key recorded in push_events, so a given bill,
 * charge or threshold is announced once no matter how often this runs.
 */

export interface PushCandidate {
  key: string;
  message: PushMessage;
  /** Other keys to mark as handled without announcing (e.g. the 80% key when 100% fires). */
  alsoClaim?: string[];
}

export interface PushScanSettings {
  /** Charges at or above this many cents are "large". */
  largeTxnCents: number;
  /** No notifications before this local hour (0-23)... */
  quietEndHour: number;
  /** ...or from this local hour on. */
  quietStartHour: number;
  /** Individual notifications per scan before the rest are folded into one. */
  maxIndividual: number;
}

export function getPushScanSettings(env: Record<string, string | undefined> = process.env): PushScanSettings {
  const int = (v: string | undefined, d: number, min: number, max: number) => {
    const n = Number.parseInt(v ?? "", 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : d;
  };
  return {
    largeTxnCents: int(env.PUSH_LARGE_TXN_CENTS, 25_000, 1, 1_000_000_00),
    quietEndHour: int(env.PUSH_QUIET_END_HOUR, 8, 0, 23),
    quietStartHour: int(env.PUSH_QUIET_START_HOUR, 21, 0, 23),
    maxIndividual: 4,
  };
}

export function isQuietHour(hour: number, s: Pick<PushScanSettings, "quietEndHour" | "quietStartHour">): boolean {
  if (s.quietStartHour === s.quietEndHour) return false;
  return s.quietStartHour > s.quietEndHour
    ? hour >= s.quietStartHour || hour < s.quietEndHour // e.g. 21:00 → 08:00
    : hour >= s.quietStartHour && hour < s.quietEndHour;
}

// ── Candidate builders (pure) ────────────────────────────────────────

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function billCandidates(bills: BillRow[], now: Date): PushCandidate[] {
  const today = localDate(now);
  const tomorrow = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const out: PushCandidate[] = [];
  for (const b of bills) {
    if (b.isIncome || !b.nextDate) continue;
    if (b.nextDate !== today && b.nextDate !== tomorrow) continue;
    const amount = b.lastAmount ?? b.averageAmount;
    out.push({
      key: `bill:${b.id}:${b.nextDate}`,
      message: {
        title: b.nextDate === today ? "Bill due today" : "Bill due tomorrow",
        body: amount ? `${b.name} · ${centsToDisplay(amount)}` : b.name,
        threadId: "bills",
        data: { kind: "bill" },
      },
    });
  }
  return out;
}

export function budgetCandidates(month: string, budget: BudgetMonth): PushCandidate[] {
  if (!budget.budget) return [];
  const out: PushCandidate[] = [];
  for (const group of budget.groups) {
    for (const c of group.categories) {
      if (c.limitAmount <= 0) continue;
      const base = `budget:${month}:${c.categoryId}`;
      if (c.spent >= c.limitAmount) {
        out.push({
          key: `${base}:100`,
          alsoClaim: [`${base}:80`],
          message: {
            title: `Over budget: ${c.categoryName}`,
            body: `${centsToDisplay(c.spent)} spent of ${centsToDisplay(c.limitAmount)}`,
            threadId: "budgets",
            data: { kind: "budget" },
          },
        });
      } else if (c.spent >= c.limitAmount * 0.8) {
        out.push({
          key: `${base}:80`,
          message: {
            title: `${c.categoryName} is at 80% of budget`,
            body: `${centsToDisplay(c.spent)} of ${centsToDisplay(c.limitAmount)} · ${centsToDisplay(c.limitAmount - c.spent)} left`,
            threadId: "budgets",
            data: { kind: "budget" },
          },
        });
      }
    }
  }
  return out;
}

export interface LargeTxnRow {
  id: string;
  name: string;
  amount: number;
  date: string;
}

export function largeTxnCandidates(rows: LargeTxnRow[]): PushCandidate[] {
  return rows.map((t) => ({
    key: `txn:${t.id}`,
    message: {
      title: `Large charge: ${centsToDisplay(t.amount)}`,
      body: t.name,
      threadId: "transactions",
      data: { kind: "transaction", id: t.id },
    },
  }));
}

export interface ConnectionRow {
  id: string;
  institutionName: string | null;
  status: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

const UNHEALTHY = ["error", "reauth_required", "revoked"] as const;

export function connectionCandidates(rows: ConnectionRow[]): PushCandidate[] {
  const out: PushCandidate[] = [];
  for (const c of rows) {
    if (!c.status || !(UNHEALTHY as readonly string[]).includes(c.status)) continue;
    const described = describeConnectionIssue({
      status: c.status as (typeof UNHEALTHY)[number],
      errorCode: c.errorCode,
      errorMessage: c.errorMessage,
    });
    const fallback =
      c.status === "reauth_required"
        ? "Sign in again to resume syncing"
        : c.status === "revoked"
          ? "Access was revoked. Reconnect to resume syncing"
          : "The last sync reported an error";
    out.push({
      key: `conn:${c.id}:${c.status}`,
      message: {
        title: `${c.institutionName ?? "A bank"}: ${described?.label ?? "needs attention"}`,
        body: described?.detail ?? fallback,
        threadId: "connections",
        data: { kind: "connection" },
      },
    });
  }
  return out;
}

// ── Orchestration ────────────────────────────────────────────────────

export interface ScanDeps {
  db?: LedgrDb;
  now?: Date;
  settings?: PushScanSettings;
  notify?: typeof notifyHousehold;
}

export interface ScanOutcome {
  candidates: number;
  announced: number;
  silent: boolean;
  skippedQuiet: boolean;
}

/** Everything Ledgr currently wants to tell this household about. */
export async function collectCandidates(
  householdId: string,
  db: LedgrDb,
  now: Date,
  settings: PushScanSettings,
): Promise<{ candidates: PushCandidate[]; healthyConnectionIds: string[] }> {
  const month = getCurrentMonth();
  const since = new Date(now.getTime() - 48 * 3_600_000);
  const oldestDate = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7));

  const [bills, budget, large, conns] = await Promise.all([
    withHousehold(householdId, (tx) => getUpcomingBills(householdId, {}, tx), db),
    withHousehold(householdId, (tx) => getBudgetForMonth(householdId, month, tx), db),
    withHousehold(
      householdId,
      (tx) =>
        tx
          .select({ id: transactions.id, name: transactions.name, amount: transactions.amount, date: transactions.date })
          .from(transactions)
          .where(
            and(
              eq(transactions.householdId, householdId),
              gte(transactions.createdAt, since),
              // A freshly linked bank backfills years of history at once; only
              // charges that are actually recent are news.
              gte(transactions.date, oldestDate),
              // Plaid convention: positive = money out.
              gte(transactions.amount, settings.largeTxnCents),
              eq(transactions.pending, false),
              eq(transactions.isTransfer, false),
              eq(transactions.isHidden, false),
              isNull(transactions.deletedAt),
            ),
          ),
      db,
    ),
    db
      .select({
        id: bankConnections.id,
        institutionName: bankConnections.institutionName,
        status: bankConnections.status,
        errorCode: bankConnections.errorCode,
        errorMessage: bankConnections.errorMessage,
      })
      .from(bankConnections)
      .where(eq(bankConnections.householdId, householdId)),
  ]);

  return {
    candidates: [
      ...connectionCandidates(conns),
      ...billCandidates(bills, now),
      ...budgetCandidates(month, budget),
      ...largeTxnCandidates(large),
    ],
    healthyConnectionIds: conns.filter((c) => c.status === "active").map((c) => c.id),
  };
}

export async function scanHousehold(householdId: string, deps: ScanDeps = {}): Promise<ScanOutcome> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();
  const settings = deps.settings ?? getPushScanSettings();
  const notify = deps.notify ?? notifyHousehold;
  const outcome: ScanOutcome = { candidates: 0, announced: 0, silent: false, skippedQuiet: false };

  if ((await listDevices(householdId, db)).length === 0) return outcome;

  // First scan for this household: everything that is already true (an
  // over-budget category, last week's big purchase) is old news. Record it
  // without announcing so only genuinely new events notify.
  const [anyEvent] = await withHousehold(
    householdId,
    (tx) => tx.select({ k: pushEvents.eventKey }).from(pushEvents).where(eq(pushEvents.householdId, householdId)).limit(1),
    db,
  );
  outcome.silent = !anyEvent;

  if (!outcome.silent && isQuietHour(now.getHours(), settings)) {
    outcome.skippedQuiet = true;
    return outcome;
  }

  const { candidates, healthyConnectionIds } = await collectCandidates(householdId, db, now, settings);
  outcome.candidates = candidates.length;

  // A bank that recovered should be announced again if it breaks again later.
  if (healthyConnectionIds.length > 0) {
    const stale = healthyConnectionIds.flatMap((id) => UNHEALTHY.map((s) => `conn:${id}:${s}`));
    await withHousehold(
      householdId,
      (tx) => tx.delete(pushEvents).where(and(eq(pushEvents.householdId, householdId), inArray(pushEvents.eventKey, stale))),
      db,
    );
  }

  const fresh: PushCandidate[] = [];
  for (const c of candidates) {
    const keys = [c.key, ...(c.alsoClaim ?? [])];
    const claimed = await withHousehold(
      householdId,
      (tx) =>
        tx
          .insert(pushEvents)
          .values(keys.map((eventKey) => ({ householdId, eventKey })))
          .onConflictDoNothing()
          .returning({ k: pushEvents.eventKey }),
      db,
    );
    if (claimed.some((r) => r.k === c.key)) fresh.push(c);
  }

  if (outcome.silent || fresh.length === 0) return outcome;

  const individual = fresh.slice(0, settings.maxIndividual);
  const rest = fresh.slice(settings.maxIndividual);
  for (const c of individual) {
    await notify(householdId, c.message, { db });
    outcome.announced++;
  }
  if (rest.length > 0) {
    await notify(
      householdId,
      { title: `${rest.length} more alerts`, body: "Open Ledgr to see everything that needs a look.", threadId: "summary" },
      { db },
    );
    outcome.announced += rest.length;
  }
  return outcome;
}

/** Scheduler entry point: scan every household that has a registered device. */
export async function runPushScan(deps: ScanDeps = {}): Promise<void> {
  if (!getApnsConfig()) return; // push not set up; stay silent
  const db = deps.db ?? defaultDb;
  const all = await db.select({ id: households.id }).from(households);
  for (const h of all) {
    try {
      const r = await scanHousehold(h.id, deps);
      if (r.announced > 0 || r.silent) {
        console.log(
          `[push] household ${h.id}: ${r.silent ? "baseline recorded" : `${r.announced} notification(s) sent`} (${r.candidates} candidate(s))`,
        );
      }
    } catch (err) {
      console.error(`[push] scan failed for household ${h.id}`, err);
    }
  }
}
