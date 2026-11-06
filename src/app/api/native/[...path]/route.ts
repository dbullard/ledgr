import { NextRequest, NextResponse } from "next/server";
import { getSession, getHouseholdId } from "@/lib/auth/session";
import { withHousehold } from "@/lib/household-context";
import {
  getDashboardSummary,
  getMonthlySpending,
  getNetWorthHistory,
  getRecentTransactions,
} from "@/queries/dashboard";
import { getBudgetForMonth } from "@/queries/budgets";
import {
  copyBudgetFromMonth,
  createBudget,
  removeBudgetCategory,
  setBudgetCategory,
  updateBudgetType,
} from "@/actions/budgets";
import { getCurrentMonth, shiftMonth } from "@/lib/date-utils";
import { triggerSync } from "@/actions/sync";
import { getAccountsByInstitution, getAccountSummary } from "@/queries/accounts";
import { balanceHistory } from "@/db/schema";
import { and, eq, gte } from "drizzle-orm";
import { getTransactions, type TransactionFilters } from "@/queries/transactions";
import { getCategories } from "@/queries/categories";
import { getItemSpendByCategory, getTopProducts } from "@/queries/receipt-items";
import { fetchTransactionDetail, updateTransactionFields } from "@/actions/transaction-detail";
import { toggleReviewed, updateTransactionCategory } from "@/actions/transactions";
import { attachReceipt, deleteReceipt, fetchReceipts, fetchUnmatchedReceipts } from "@/actions/receipts";

export const dynamic = "force-dynamic";

/**
 * JSON API for the native iPhone and Mac apps. A thin layer over the same
 * queries and actions the web pages use, behind the same session cookie, so
 * the native screens see exactly what the web app does.
 *
 *   GET    /api/native/dashboard?range=1M|3M|6M|1Y|all
 *   GET    /api/native/transactions?search&needsReview&categoryId&cursor&limit
 *   GET    /api/native/transactions/:id
 *   PATCH  /api/native/transactions/:id   { categoryId?, reviewed?, notes? }
 *   GET    /api/native/categories
 *   GET    /api/native/receipts                      (waiting for a transaction)
 *   POST   /api/native/receipts/attach   { receiptId, transactionId }
 *   DELETE /api/native/receipts/:id
 *   GET    /api/native/items?from&to
 *   GET    /api/native/accounts                      (grouped by institution + totals)
 *   GET    /api/native/accounts/:id/history?days=90
 *   GET    /api/native/budgets?month=YYYY-MM
 *   POST   /api/native/budgets           { month, copyFromPrevious? }
 *   PATCH  /api/native/budgets/:id       { type: "category"|"flex" }
 *   PATCH  /api/native/budgets/:id/categories/:categoryId   { limit }   (cents)
 *   DELETE /api/native/budgets/:id/categories/:categoryId
 *   POST   /api/native/accounts/sync     { connectionId }   (refresh one bank connection)
 */

const RANGES = ["1M", "3M", "6M", "1Y", "all"] as const;
type Range = (typeof RANGES)[number];

function fail(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

function ok(data: unknown) {
  return NextResponse.json(data);
}

function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (!(await getSession())) return fail("Unauthorized", 401);
  const segs = (await ctx.params).path;
  const [head, id] = segs;
  const q = req.nextUrl.searchParams;
  const method = req.method;
  const householdId = await getHouseholdId();

  if (head === "dashboard" && method === "GET") {
    const asked = q.get("range") as Range | null;
    const range: Range = asked && RANGES.includes(asked) ? asked : "6M";
    const [summary, history, spending, recent] = await Promise.all([
      withHousehold(householdId, (tx) => getDashboardSummary(householdId, undefined, tx)),
      getNetWorthHistory(householdId, range),
      withHousehold(householdId, (tx) => getMonthlySpending(householdId, undefined, tx)),
      withHousehold(householdId, (tx) => getRecentTransactions(householdId, 8, tx)),
    ]);
    return ok({ summary, history, spending, recent });
  }

  if (head === "budgets") {
    const monthRe = /^\d{4}-\d{2}$/;
    if (!id && method === "GET") {
      const asked = q.get("month") ?? "";
      const month = monthRe.test(asked) ? asked : getCurrentMonth();
      const prev = shiftMonth(month, -1);
      const [data, prevData] = await Promise.all([
        withHousehold(householdId, (tx) => getBudgetForMonth(householdId, month, tx)),
        withHousehold(householdId, (tx) => getBudgetForMonth(householdId, prev, tx)),
      ]);
      return ok({ month, previousMonth: prev, hasPreviousBudget: prevData.budget !== null, ...data });
    }
    if (!id && method === "POST") {
      const body = (await req.json().catch(() => null)) as { month?: string; copyFromPrevious?: boolean } | null;
      if (!body?.month || !monthRe.test(body.month)) return fail("Invalid month");
      const result = body.copyFromPrevious
        ? await copyBudgetFromMonth(shiftMonth(body.month, -1), body.month)
        : await createBudget(body.month);
      return "error" in result ? fail(result.error) : ok(result);
    }
    if (id && !segs[2] && method === "PATCH") {
      const body = (await req.json().catch(() => null)) as { type?: "category" | "flex" } | null;
      if (!body?.type) return fail("Invalid input");
      const result = await updateBudgetType(id, body.type);
      return "error" in result ? fail(result.error) : ok(result);
    }
    if (id && segs[2] === "categories" && segs[3] && method === "PATCH") {
      const body = (await req.json().catch(() => null)) as { limit?: number } | null;
      if (typeof body?.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 0) return fail("Invalid amount");
      const result = await setBudgetCategory(id, segs[3], body.limit);
      return "error" in result ? fail(result.error) : ok(result);
    }
    if (id && segs[2] === "categories" && segs[3] && method === "DELETE") {
      const result = await removeBudgetCategory(id, segs[3]);
      return "error" in result ? fail(result.error) : ok(result);
    }
  }

  if (head === "accounts" && !id && method === "GET") {
    const [groups, summary] = await withHousehold(householdId, (tx) =>
      Promise.all([getAccountsByInstitution(householdId, tx), getAccountSummary(householdId, tx)]),
    );
    return ok({
      summary,
      groups: groups.map((g) => ({
        institutionName: g.institutionName,
        connectionId: g.connectionId,
        provider: g.provider,
        status: g.status,
        errorMessage: g.errorMessage,
        lastDataAt: g.lastDataAt,
        primaryColor: g.primaryColor,
        accounts: g.accounts.map((a) => ({
          id: a.id,
          name: a.name,
          officialName: a.officialName,
          type: a.type,
          subtype: a.subtype,
          currentBalance: a.currentBalance,
          availableBalance: a.availableBalance,
          creditLimit: a.creditLimit,
          isHidden: a.isHidden ?? false,
          isManual: a.isManual ?? false,
        })),
      })),
    });
  }

  if (head === "accounts" && id === "sync" && method === "POST") {
    const body = (await req.json().catch(() => null)) as { connectionId?: string } | null;
    if (!body?.connectionId) return fail("Invalid input");
    const result = await triggerSync(body.connectionId);
    return result.success ? ok(result) : fail(result.error, 502);
  }

  if (head === "accounts" && id && segs[2] === "history" && method === "GET") {
    const days = Math.min(Math.max(Number(q.get("days")) || 90, 7), 1825);
    const from = iso(new Date(Date.now() - days * 86_400_000));
    const rows = await withHousehold(householdId, async (tx) => {
      const owned = await getAccountsByInstitution(householdId, tx);
      if (!owned.some((g) => g.accounts.some((a) => a.id === id))) return null;
      return tx
        .select({ date: balanceHistory.date, balance: balanceHistory.balance })
        .from(balanceHistory)
        .where(and(eq(balanceHistory.accountId, id), gte(balanceHistory.date, from)))
        .orderBy(balanceHistory.date);
    });
    if (!rows) return fail("Not found", 404);
    return ok(rows);
  }

  if (head === "transactions" && !id && method === "GET") {
    const filters: TransactionFilters = {};
    const search = q.get("search")?.trim();
    if (search) filters.search = search;
    if (q.get("needsReview") === "1") filters.needsReview = true;
    if (q.get("categoryId")) filters.categoryId = q.get("categoryId");
    if (q.get("accountId")) filters.accountId = q.get("accountId") ?? undefined;
    if (q.get("dateFrom")) filters.dateFrom = q.get("dateFrom") ?? undefined;
    if (q.get("dateTo")) filters.dateTo = q.get("dateTo") ?? undefined;
    const type = q.get("type");
    if (type === "expense" || type === "credits" || type === "transfer") filters.transactionType = type;
    const limit = Math.min(Math.max(Number(q.get("limit")) || 40, 1), 100);
    const page = await withHousehold(householdId, (tx) =>
      getTransactions(householdId, filters, limit, q.get("cursor"), tx),
    );
    return ok(page);
  }

  if (head === "transactions" && id && method === "GET") {
    const detail = await fetchTransactionDetail(id);
    if ("error" in detail) return fail(detail.error, 404);
    const receipts = await fetchReceipts(id);
    return ok({ ...detail.data, receipts: "data" in receipts ? receipts.data : [] });
  }

  if (head === "transactions" && id && method === "PATCH") {
    const body = (await req.json().catch(() => null)) as {
      categoryId?: string | null;
      reviewed?: boolean;
      notes?: string;
    } | null;
    if (!body) return fail("Invalid input");
    if ("categoryId" in body) {
      const res = await updateTransactionCategory(id, body.categoryId ?? null);
      if ("error" in res) return fail(res.error);
    }
    if (typeof body.notes === "string") {
      const res = await updateTransactionFields(id, { notes: body.notes });
      if ("error" in res) return fail(res.error);
    }
    if (typeof body.reviewed === "boolean") {
      const current = await fetchTransactionDetail(id);
      if ("error" in current) return fail(current.error, 404);
      if (current.data.reviewed !== body.reviewed) {
        const res = await toggleReviewed(id);
        if ("error" in res) return fail(res.error);
      }
    }
    const detail = await fetchTransactionDetail(id);
    if ("error" in detail) return fail(detail.error, 404);
    return ok(detail.data);
  }

  if (head === "categories" && method === "GET") {
    return ok(await withHousehold(householdId, (tx) => getCategories(householdId, tx)));
  }

  if (head === "receipts" && !id && method === "GET") {
    const res = await fetchUnmatchedReceipts();
    return "error" in res ? fail(res.error) : ok(res.data);
  }

  if (head === "receipts" && id === "attach" && method === "POST") {
    const body = (await req.json().catch(() => null)) as { receiptId?: string; transactionId?: string } | null;
    if (!body?.receiptId || !body.transactionId) return fail("Invalid input");
    const res = await attachReceipt(body.receiptId, body.transactionId);
    return "error" in res ? fail(res.error) : ok(res);
  }

  if (head === "receipts" && id && id !== "attach" && method === "DELETE") {
    const res = await deleteReceipt(id);
    return "error" in res ? fail(res.error) : ok(res);
  }

  if (head === "items" && method === "GET") {
    const to = q.get("to") ?? iso(new Date());
    const from = q.get("from") ?? iso(new Date(Date.parse(`${to}T00:00:00Z`) - 90 * 86_400_000));
    const filters = { dateFrom: from, dateTo: to };
    const [byCategory, products] = await Promise.all([
      withHousehold(householdId, (tx) => getItemSpendByCategory(householdId, filters, tx)),
      withHousehold(householdId, (tx) => getTopProducts(householdId, filters, 30, tx)),
    ]);
    return ok({ from, to, byCategory, products });
  }

  return fail("Not found", 404);
}

async function guarded(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  try {
    return await handle(req, ctx);
  } catch (e) {
    console.error("[native-api]", e);
    return fail("Something went wrong", 500);
  }
}

export const GET = guarded;
export const PATCH = guarded;
export const POST = guarded;
export const DELETE = guarded;
