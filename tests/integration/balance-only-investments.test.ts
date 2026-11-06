import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";
import {
  insertHousehold,
  insertAccount,
  insertInvestmentHolding,
  insertHoldingsSnapshot,
  insertTransaction,
} from "./helpers";
import { accounts, balanceHistory } from "@/db/schema";
import {
  getPortfolioSummary,
  getAssetAllocation,
  getHoldings,
  getPortfolioHistory,
  getAccountReconciliation,
  getBalanceGrowth,
} from "@/queries/investments";
import { setAccountFundScoped } from "@/actions/investments";
import type { LedgrDb } from "@/db";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * A connector can report an investment account's balance and nothing else (a
 * 403(b) over SimpleFIN). These cover what Investments shows for such an
 * account: a portfolio line from balance snapshots, a growth estimate, and the
 * single-fund itemization a user can set.
 */
describe("balance-only investment accounts", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;
  let householdId: string;
  let accountId: string;

  async function snapshot(id: string, date: string, balance: number) {
    await db.insert(balanceHistory).values({ id: uuid(), accountId: id, date, balance });
  }

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    ({ householdId } = await insertHousehold(db));
    ({ accountId } = await insertAccount(db, householdId, { type: "investment", currentBalance: 3300000 }));
  });

  afterEach(async () => {
    await close();
  });

  describe("single-fund itemization", () => {
    async function setFund() {
      await db.update(accounts).set({ fundTicker: "GMGZX", fundName: "MyDestination 2055 Fund" }).where(eq(accounts.id, accountId));
    }

    it("shows no holdings until the user says the account is a fund", async () => {
      expect(await getHoldings(householdId, "consolidated", undefined, db)).toEqual([]);
      const [row] = await getAccountReconciliation(householdId, db);
      expect(row.hasHoldings).toBe(false);
      expect(row.cashValue).toBe(3300000);
    });

    it("lists the fund as one position worth the account balance", async () => {
      await setFund();

      const holdings = await getHoldings(householdId, "consolidated", undefined, db);
      expect(holdings).toHaveLength(1);
      expect(holdings[0]).toMatchObject({
        ticker: "GMGZX",
        securityName: "MyDestination 2055 Fund",
        type: "mutual_fund",
        currentValue: 3300000,
      });

      const byAccount = await getHoldings(householdId, "by-account", undefined, db);
      expect(byAccount[0].accountId).toBe(accountId);
    });

    it("allocates the whole account to mutual funds and leaves no cash gap", async () => {
      await setFund();

      expect(await getAssetAllocation(householdId, db)).toEqual([
        { type: "mutual_fund", value: 3300000, percentage: 100 },
      ]);
      const summary = await getPortfolioSummary(householdId, db);
      expect(summary.totalValue).toBe(3300000);
      expect(summary.holdingsValue).toBe(3300000);
      expect(summary.cashValue).toBe(0);
      const [row] = await getAccountReconciliation(householdId, db);
      expect(row).toMatchObject({ hasHoldings: true, hasSyncedHoldings: false, fundTicker: "GMGZX", cashValue: 0 });
    });

    it("follows the balance when it changes", async () => {
      await setFund();
      await db.update(accounts).set({ currentBalance: 3400000 }).where(eq(accounts.id, accountId));

      const [holding] = await getHoldings(householdId, "consolidated", undefined, db);
      expect(holding.currentValue).toBe(3400000);
    });

    it("steps aside when the connector itemizes the account itself", async () => {
      await setFund();
      await insertInvestmentHolding(db, accountId, { currentValue: 3000000, ticker: "VTI", securityName: "Vanguard Total", plaidSecurityId: "sec-vti" });

      const holdings = await getHoldings(householdId, "consolidated", undefined, db);
      expect(holdings.map((h) => h.ticker)).toEqual(["VTI"]);
      const [row] = await getAccountReconciliation(householdId, db);
      expect(row.hasSyncedHoldings).toBe(true);
      expect(row.holdingsValue).toBe(3000000);
    });

    it("reports a day change from the balance snapshots", async () => {
      await setFund();
      await snapshot(accountId, "2026-11-01", 3200000);
      await snapshot(accountId, "2026-11-02", 3300000);

      const summary = await getPortfolioSummary(householdId, db, "2026-11-02");
      expect(summary.dayChange).toBe(100000);
    });
  });

  describe("getPortfolioHistory", () => {
    const range = { dateFrom: "2026-10-01", dateTo: "2026-11-30" };

    it("charts a balance-only account from its balance snapshots", async () => {
      await snapshot(accountId, "2026-10-31", 3263063);
      await snapshot(accountId, "2026-11-01", 3300000);

      expect(await getPortfolioHistory(householdId, range, db)).toEqual([
        { date: "2026-10-31", value: 3263063 },
        { date: "2026-11-01", value: 3300000 },
      ]);
    });

    it("combines it with a holdings-backed account, carrying values across missing days", async () => {
      const other = await insertAccount(db, householdId, { type: "investment" });
      await insertHoldingsSnapshot(db, other.accountId, "2026-10-31", { value: 1000000 });
      await insertHoldingsSnapshot(db, other.accountId, "2026-11-02", { value: 1100000 });
      await snapshot(accountId, "2026-11-01", 3300000);

      const points = await getPortfolioHistory(householdId, range, db);
      expect(points).toEqual([
        { date: "2026-10-31", value: 1000000 },
        { date: "2026-11-01", value: 4300000 },
        { date: "2026-11-02", value: 4400000 },
      ]);
    });
  });

  describe("getBalanceGrowth", () => {
    const range = { dateFrom: "2026-10-01", dateTo: "2026-11-30" };

    it("separates what was put in from what the account grew by", async () => {
      await snapshot(accountId, "2026-10-31", 3000000);
      await snapshot(accountId, "2026-11-20", 3100000);
      // Counted: after the first snapshot. Not counted: the one the first snapshot already includes.
      await insertTransaction(db, householdId, accountId, { date: "2026-11-05", normalizedAmount: 22533, amount: -22533 });
      await insertTransaction(db, householdId, accountId, { date: "2026-10-21", normalizedAmount: 22533, amount: -22533 });

      const growth = await getBalanceGrowth(householdId, range, db);
      expect(growth).toEqual({
        since: "2026-10-31",
        startValue: 3000000,
        endValue: 3100000,
        netContributions: 22533,
        growth: 100000 - 22533,
      });
    });

    it("starts where contributions are on record, not where balance history begins", async () => {
      // A balance history that reaches back months before Ledgr saw any
      // transaction. Contributions made in that stretch are unknown, so counting
      // from the start would book them all as growth.
      await snapshot(accountId, "2026-06-01", 2800000);
      await snapshot(accountId, "2026-08-19", 3000000);
      await snapshot(accountId, "2026-11-20", 3100000);
      await insertTransaction(db, householdId, accountId, { date: "2026-08-20", normalizedAmount: 22533, amount: -22533 });
      await insertTransaction(db, householdId, accountId, { date: "2026-09-18", normalizedAmount: 22533, amount: -22533 });

      const growth = await getBalanceGrowth(householdId, { dateFrom: "2026-01-01", dateTo: "2026-11-30" }, db);
      expect(growth).toEqual({
        since: "2026-08-19",
        startValue: 3000000,
        endValue: 3100000,
        netContributions: 45066,
        growth: 100000 - 45066,
      });
    });

    it("needs two snapshots before it says anything", async () => {
      await snapshot(accountId, "2026-10-31", 3000000);
      expect(await getBalanceGrowth(householdId, range, db)).toBeNull();
    });

    it("leaves accounts the connector itemizes to the holdings figures", async () => {
      await insertInvestmentHolding(db, accountId, { currentValue: 3000000 });
      await snapshot(accountId, "2026-10-31", 3000000);
      await snapshot(accountId, "2026-11-20", 3100000);
      expect(await getBalanceGrowth(householdId, range, db)).toBeNull();
    });
  });

  describe("setAccountFundScoped", () => {
    it("sets, normalizes and clears the fund on an investment account", async () => {
      expect(await setAccountFundScoped(householdId, accountId, { ticker: " gmgzx ", name: "  MyDestination 2055  " }, db)).toEqual({ success: true });
      const [set] = await db.select({ t: accounts.fundTicker, n: accounts.fundName }).from(accounts).where(eq(accounts.id, accountId));
      expect(set).toEqual({ t: "GMGZX", n: "MyDestination 2055" });

      expect(await setAccountFundScoped(householdId, accountId, null, db)).toEqual({ success: true });
      const [cleared] = await db.select({ t: accounts.fundTicker, n: accounts.fundName }).from(accounts).where(eq(accounts.id, accountId));
      expect(cleared).toEqual({ t: null, n: null });
    });

    it("refuses a bad ticker, a non-investment account, and another household's account", async () => {
      expect(await setAccountFundScoped(householdId, accountId, { ticker: "not a ticker!" }, db)).toHaveProperty("error");

      const { accountId: checking } = await insertAccount(db, householdId, { type: "checking" });
      expect(await setAccountFundScoped(householdId, checking, { ticker: "GMGZX" }, db)).toHaveProperty("error");

      const other = await insertHousehold(db, "Other");
      expect(await setAccountFundScoped(other.householdId, accountId, { ticker: "GMGZX" }, db)).toHaveProperty("error");
    });
  });
});
