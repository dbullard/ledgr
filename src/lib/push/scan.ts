import { and, count, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db as defaultDb, type LedgrDb } from "@/db";
import { accounts, bankConnections, households, pushEvents, transactions } from "@/db/schema";
import { withHousehold } from "@/lib/household-context";
import { getBudgetForMonth, type BudgetMonth } from "@/queries/budgets";
import { getUpcomingBills, type BillRow } from "@/queries/recurring";
import { describeConnectionIssue } from "@/lib/connection-issue";
import { getCurrentMonth } from "@/lib/date-utils";
import { centsToDisplay } from "@/lib/money";
import { getApnsConfig, type PushMessage } from "./apns";
import { applyPreferences, getPushPreferences } from "./preferences";
import { getPushScanSettings, isQuietHour, type PushScanSettings } from "./scan-settings";

import { listDevices } from "./devices";
import { notifyHousehold } from "./notify";

export { getPushScanSettings, isQuietHour, type PushScanSettings } from "./scan-settings";

export type PushType = "bills" | "largeCharges" | "budgets" | "connections" | "lowBalance" | "deposits" | "review" | "weekly";

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
  type: PushType;
  key: string;
  message: PushMessage;
  /** Other keys to mark as handled without announcing (e.g. the 80% key when 100% fires). */
  alsoClaim?: string[];
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
      type: "bills",
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
          type: "budgets",
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
          type: "budgets",
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
    type: "largeCharges" as const,
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
      type: "connections",
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

export interface BalanceRow {
  id: string;
  name: string;
  currentBalance: number | null;
}

/** Accounts whose balance is under the limit. Keyed per account; cleared when it recovers. */
export function lowBalanceCandidates(rows: BalanceRow[], limitCents: number): PushCandidate[] {
  return rows
    .filter((a) => a.currentBalance !== null && a.currentBalance < limitCents)
    .map((a) => ({
      type: "lowBalance" as const,
      key: `lowbal:${a.id}`,
      message: {
        title: `Low balance: ${a.name}`,
        body: `${centsToDisplay(a.currentBalance as number)} (under ${centsToDisplay(limitCents)})`,
        threadId: "balances",
        data: { kind: "balance", id: a.id },
      },
    }));
}

/** Money in: keyed on the transaction. `rows` use the Plaid sign (negative = income). */
export function depositCandidates(rows: LargeTxnRow[]): PushCandidate[] {
  return rows.map((t) => ({
    type: "deposits" as const,
    key: `dep:${t.id}`,
    message: {
      title: `Deposit: ${centsToDisplay(Math.abs(t.amount))}`,
      body: t.name,
      threadId: "transactions",
      data: { kind: "transaction", id: t.id },
    },
  }));
}

/** At most one nudge a day, and only when enough has piled up to be worth a look. */
export function reviewCandidates(count: number, now: Date, minimum = 5): PushCandidate[] {
  if (count < minimum) return [];
  return [
    {
      type: "review",
      key: `review:${localDate(now)}`,
      message: {
        title: `${count} transactions need a category`,
        body: "A minute now keeps your budgets and reports accurate.",
        threadId: "review",
        data: { kind: "review" },
      },
    },
  ];
}

export interface WeekSummary {
  spentCents: number;
  incomeCents: number;
  charges: number;
}

/** Sunday-morning recap, once per week. Returns nothing on other days or before 9am. */
export function weeklyCandidates(week: WeekSummary, now: Date): PushCandidate[] {
  if (now.getDay() !== 0 || now.getHours() < 9) return [];
  const parts = [`Spent ${centsToDisplay(week.spentCents)} across ${week.charges} charge${week.charges === 1 ? "" : "s"}`];
  if (week.incomeCents > 0) parts.push(`${centsToDisplay(week.incomeCents)} came in`);
  return [
    {
      type: "weekly",
      key: `weekly:${localDate(now)}`,
      message: { title: "Your week in Ledgr", body: parts.join(" · "), threadId: "weekly", data: { kind: "weekly" } },
    },
  ];
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
): Promise<{ candidates: PushCandidate[]; staleKeys: string[] }> {
  const month = getCurrentMonth();
  const since = new Date(now.getTime() - 48 * 3_600_000);
  const oldestDate = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7));

  const [bills, budget, large, conns, balances, deposits, backlog, week] = await Promise.all([
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
    // Only looked at when the alert is on, so switching it on later reports
    // accounts that are already low instead of silently claiming them.
    settings.types.lowBalance
      ? withHousehold(
          householdId,
          (tx) =>
            tx
              .select({ id: accounts.id, name: accounts.name, currentBalance: accounts.currentBalance })
              .from(accounts)
              .where(
                and(
                  eq(accounts.householdId, householdId),
                  inArray(accounts.type, ["checking", "savings"]),
                  eq(accounts.isHidden, false),
                  isNull(accounts.deletedAt),
                ),
              ),
          db,
        )
      : Promise.resolve([] as BalanceRow[]),
    settings.types.deposits
      ? withHousehold(
          householdId,
          (tx) =>
            tx
              .select({ id: transactions.id, name: transactions.name, amount: transactions.amount, date: transactions.date })
              .from(transactions)
              .where(
                and(
                  eq(transactions.householdId, householdId),
                  gte(transactions.createdAt, since),
                  gte(transactions.date, oldestDate),
                  // Negative = money in.
                  lte(transactions.amount, -settings.depositCents),
                  eq(transactions.pending, false),
                  eq(transactions.isTransfer, false),
                  eq(transactions.isHidden, false),
                  isNull(transactions.deletedAt),
                ),
              ),
          db,
        )
      : Promise.resolve([] as LargeTxnRow[]),
    settings.types.review
      ? withHousehold(
          householdId,
          async (tx) => {
            const [r] = await tx
              .select({ n: count() })
              .from(transactions)
              .where(
                and(
                  eq(transactions.householdId, householdId),
                  isNull(transactions.categoryId),
                  gte(transactions.date, localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30))),
                  eq(transactions.pending, false),
                  eq(transactions.isTransfer, false),
                  eq(transactions.isHidden, false),
                  isNull(transactions.deletedAt),
                ),
              );
            return r?.n ?? 0;
          },
          db,
        )
      : Promise.resolve(0),
    settings.types.weekly && now.getDay() === 0
      ? withHousehold(
          householdId,
          async (tx): Promise<WeekSummary> => {
            const [r] = await tx
              .select({
                spent: sql<number>`coalesce(sum(case when ${transactions.amount} > 0 then ${transactions.amount} else 0 end), 0)::int`,
                income: sql<number>`coalesce(-sum(case when ${transactions.amount} < 0 then ${transactions.amount} else 0 end), 0)::int`,
                charges: sql<number>`count(*) filter (where ${transactions.amount} > 0)::int`,
              })
              .from(transactions)
              .where(
                and(
                  eq(transactions.householdId, householdId),
                  gte(transactions.date, localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7))),
                  eq(transactions.pending, false),
                  eq(transactions.isTransfer, false),
                  eq(transactions.isHidden, false),
                  isNull(transactions.deletedAt),
                ),
              );
            return { spentCents: r?.spent ?? 0, incomeCents: r?.income ?? 0, charges: r?.charges ?? 0 };
          },
          db,
        )
      : Promise.resolve(null),
  ]);

  return {
    candidates: [
      ...connectionCandidates(conns),
      ...billCandidates(bills, now),
      ...budgetCandidates(month, budget),
      ...largeTxnCandidates(large),
      ...lowBalanceCandidates(balances, settings.lowBalanceCents),
      ...depositCandidates(deposits),
      ...reviewCandidates(backlog, now),
      ...(week ? weeklyCandidates(week, now) : []),
    ],
    // Keys to forget so a recovered bank / topped-up account is announced again if it recurs.
    staleKeys: [
      ...conns.filter((c) => c.status === "active").flatMap((c) => UNHEALTHY.map((st) => `conn:${c.id}:${st}`)),
      ...balances
        .filter((a) => a.currentBalance === null || a.currentBalance >= settings.lowBalanceCents)
        .map((a) => `lowbal:${a.id}`),
    ],
  };
}

export async function scanHousehold(householdId: string, deps: ScanDeps = {}): Promise<ScanOutcome> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();
  // Per-household choices (types on/off, threshold, quiet hours) layer over the env defaults.
  const settings = deps.settings ?? applyPreferences(getPushScanSettings(), await getPushPreferences(householdId, db));
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
  // Master switch off behaves like the first scan: events are recorded, nothing is sent,
  // so turning it back on later does not replay everything that happened meanwhile.
  outcome.silent = !anyEvent || !settings.enabled;

  if (!outcome.silent && isQuietHour(now.getHours(), settings)) {
    outcome.skippedQuiet = true;
    return outcome;
  }

  const { candidates, staleKeys } = await collectCandidates(householdId, db, now, settings);
  outcome.candidates = candidates.length;

  if (staleKeys.length > 0) {
    await withHousehold(
      householdId,
      (tx) => tx.delete(pushEvents).where(and(eq(pushEvents.householdId, householdId), inArray(pushEvents.eventKey, staleKeys))),
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

  // Switched-off types are still claimed above, so turning one on later only
  // announces what is new from then on rather than replaying old events.
  const wanted = fresh.filter((c) => settings.types[c.type]);
  if (outcome.silent || wanted.length === 0) return outcome;

  const individual = wanted.slice(0, settings.maxIndividual);
  const rest = wanted.slice(settings.maxIndividual);
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
