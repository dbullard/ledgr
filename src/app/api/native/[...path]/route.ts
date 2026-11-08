import { NextRequest, NextResponse } from "next/server";
import { getSession, getHouseholdId } from "@/lib/auth/session";
import { withHousehold } from "@/lib/household-context";
import {
  getDashboardSummary,
  getMonthlySpending,
  getNetWorthHistory,
  getRecentTransactions,
} from "@/queries/dashboard";
import {
  getCategoryTrends,
  getIncomeExpenseByCategory,
  getIncomeVsExpense,
  getReportNetWorthHistory,
  getSafeToSpend,
  getSpendingByCategory,
} from "@/queries/reports";
import { comparisonLabel, shiftDateRange } from "@/lib/date-utils";
import {
  getAccountReconciliation,
  getAssetAllocation,
  getBalanceGrowth,
  getHoldings,
  getInvestmentAccountIds,
  getInvestmentTransactions,
  getPortfolioHistory,
  getPortfolioSummary,
} from "@/queries/investments";
import { rangeToDateBounds } from "@/lib/date-utils";
import { getCategoryRules } from "@/queries/category-rules";
import { getCategorySuggestions, setCategorySuggestion } from "@/lib/ai/category-suggestions";
import {
  createCategoryRule,
  deleteCategoryRule,
  updateCategoryRule,
} from "@/actions/category-rules";
import {
  createCategory,
  createCategoryGroup,
  deleteCategory,
  deleteCategoryGroup,
  mergeCategories,
  mergeCategoryGroups,
  moveCategoryToGroup,
  renameCategory,
  renameCategoryGroup,
  updateCategoryExclusion,
  updateCategoryGroupColor,
  updateCategoryGroupIcon,
  updateCategoryColor,
  updateCategoryIcon,
} from "@/actions/categories";
import { getMcpSettings } from "@/queries/mcp-settings";
import { revokeMcpClient, toggleMcpEndpoint } from "@/actions/mcp-settings";
import { toggleDemoMode } from "@/actions/demo-mode";
import { isDemoMode } from "@/lib/demo-mode";
import { getAccountsForImport } from "@/queries/accounts";
import { getRecurrings, getRecurringSummary, getRecurringTransactions, getRecurringSuggestions, previewRecurringMatches } from "@/queries/recurring";
import {
  createRecurringTransaction,
  linkTransactionToRecurring,
  makeTransactionRecurring,
  setRecurringStatus,
  unlinkTransactionFromRecurring,
  updateRecurringRules,
} from "@/actions/recurring";
import { getBudgetForMonth } from "@/queries/budgets";
import { getApnsConfig } from "@/lib/push/apns";
import {
  listDevices,
  normalizeEnvironment,
  normalizeToken,
  registerDevice,
  unregisterDevice,
} from "@/lib/push/devices";
import { notifyHousehold } from "@/lib/push/notify";
import { getPushPreferences, parsePreferencesPatch, updatePushPreferences } from "@/lib/push/preferences";
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
import { balanceHistory, bankConnections } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { and, eq, gte, inArray } from "drizzle-orm";
import { getTransactions, type TransactionFilters } from "@/queries/transactions";
import { getCategories } from "@/queries/categories";
import { getItemSpendByCategory, getProductPriceHistory, getTopProducts } from "@/queries/receipt-items";
import { fetchTransactionDetail, updateTransactionFields } from "@/actions/transaction-detail";
import { toggleReviewed, updateTransactionCategory } from "@/actions/transactions";
import { fetchReceiptItems } from "@/actions/receipt-items";
import { attachReceipt, deleteReceipt, detachReceipt, fetchReceipts, fetchUnmatchedReceipts, uploadReceipt } from "@/actions/receipts";

export const dynamic = "force-dynamic";

/**
 * JSON API for the native iPhone and Mac apps. A thin layer over the same
 * queries and actions the web pages use, behind the same session cookie, so
 * the native screens see exactly what the web app does.
 *
 *   GET    /api/native/dashboard?range=1M|3M|6M|1Y|all
 *   GET    /api/native/transactions?search&needsReview&categoryId&uncategorized&amount(cents, exact)&cursor&limit
 *   GET    /api/native/transactions/:id
 *   PATCH  /api/native/transactions/:id   { categoryId?, reviewed?, notes?, name?, iconOverride?, iconColor?, isTransfer? }
 *   GET    /api/native/category-suggestions?ids=a,b   cached on-device AI picks { [txnId]: categoryId | null }
 *   PUT    /api/native/category-suggestions/:txnId    { categoryId: string | null }
 *   GET    /api/native/categories
 *   GET    /api/native/receipts                      (waiting for a transaction)
 *   POST   /api/native/transactions/:id/receipts   (multipart `file`; attaches directly)
 *   POST   /api/native/transactions/:id/recurring  { recurringId? }   (no id = make it a new recurring item)
 *   DELETE /api/native/transactions/:id/recurring   (take it out of its recurring item)
 *   POST   /api/native/receipts/attach   { receiptId, transactionId }
 *   POST   /api/native/receipts/:id/detach   (back to the waiting list; the matcher won't re-attach it)
 *   DELETE /api/native/receipts/:id
 *   GET    /api/native/items?from&to&category&q
 *   GET    /api/native/items/history?key
 *   GET    /api/native/accounts                      (grouped by institution + totals)
 *   GET    /api/native/accounts/:id/history?days=90
 *   GET    /api/native/settings                      (profile, demo mode, MCP access)
 *   POST   /api/native/settings/demo-mode    (toggle)
 *   PATCH  /api/native/settings/mcp          { enabled }
 *   DELETE /api/native/settings/mcp/:clientId
 *   GET    /api/native/import/accounts       (accounts an import can target)
 *   (file import itself uses the existing POST /api/import multipart endpoint)
 *   GET    /api/native/reports/spending|income-expense|cash-flow|trends|net-worth?range=1M|3M|6M|1Y|all  (or from&to)
 *   GET    /api/native/investments/overview?range=1M|3M|6M|1Y|all
 *   GET    /api/native/investments/holdings?view=consolidated|by-account&accountId
 *   GET    /api/native/investments/transactions?type&accountId&cursor
 *   POST   /api/native/categories        { name, groupId, isIncome? }
 *   PATCH  /api/native/categories/:id    { name } | { icon?: lucideName | null, color?: "#RRGGBB" | null }   DELETE /api/native/categories/:id
 *   POST   /api/native/category-groups   { name }
 *   PATCH  /api/native/category-groups/:id { name } | { icon?: lucideName | null, color?: "#RRGGBB" | null }   DELETE /api/native/category-groups/:id
 *   GET    /api/native/category-rules
 *   POST   /api/native/category-rules    { categoryId, matchField, matchPattern, priority }
 *   PATCH  /api/native/category-rules/:id  (same fields)  DELETE /api/native/category-rules/:id
 *   GET    /api/native/recurring                     (bucketed list + monthly totals)
 *   GET    /api/native/recurring/:id/transactions
 *   PATCH  /api/native/recurring/:id    { status: "active"|"paused"|"archived" }
 *   POST   /api/native/recurring        { name, amount, frequency, nextDate }
 *   GET    /api/native/budgets?month=YYYY-MM
 *   POST   /api/native/budgets           { month, copyFromPrevious? }
 *   PATCH  /api/native/budgets/:id       { type: "category"|"flex" }
 *   PATCH  /api/native/budgets/:id/categories/:categoryId   { limit }   (cents)
 *   DELETE /api/native/budgets/:id/categories/:categoryId
 *   POST   /api/native/accounts/sync     { connectionId }   (refresh one bank connection)
 *   POST   /api/native/accounts/sync     { all: true }      (refresh every connection that can sync)
 *   GET    /api/native/push                          ({ configured, devices }: is APNs set up on the server)
 *   POST   /api/native/push/register     { token, environment: "sandbox"|"production" }   (this device's APNs token)
 *   DELETE /api/native/push/register     { token }   (call on sign-out)
 *   GET    /api/native/push/preferences              (which notifications are on, large-charge threshold, quiet hours)
 *   PATCH  /api/native/push/preferences  { bills?, largeCharges?, budgets?, connections?, largeChargeCents?, quietEnabled?, quietStartHour?, quietEndHour? }
 *   POST   /api/native/push/test                     (send a test notification to this household's devices)
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

  if (head === "settings") {
    const session = await getSession();
    if (!session) return fail("Unauthorized", 401);
    if (!id && method === "GET") {
      const [mcp, demo] = await Promise.all([getMcpSettings(session.user.id), isDemoMode(session.user.id)]);
      return ok({
        user: { name: session.user.name ?? null, email: session.user.email },
        demoEnabled: demo,
        mcpEnabled: mcp.mcpEnabled,
        connectedClients: mcp.connectedClients,
      });
    }
    if (id === "demo-mode" && method === "POST") {
      const result = await toggleDemoMode();
      return "error" in result ? fail(result.error) : ok(result);
    }
    if (id === "mcp" && !segs[2] && method === "PATCH") {
      const body = (await req.json().catch(() => null)) as { enabled?: boolean } | null;
      if (typeof body?.enabled !== "boolean") return fail("Invalid input");
      const result = await toggleMcpEndpoint({ mcpEnabled: body.enabled });
      return "error" in result ? fail(result.error) : ok(result);
    }
    if (id === "mcp" && segs[2] && method === "DELETE") {
      const result = await revokeMcpClient({ clientId: segs[2] });
      return "error" in result ? fail(result.error) : ok(result);
    }
  }

  if (head === "import" && id === "accounts" && method === "GET") {
    return ok(await withHousehold(householdId, (tx) => getAccountsForImport(householdId, tx)));
  }

  if (head === "reports" && method === "GET") {
    const tab = id ?? "";
    const from = q.get("from");
    const to = q.get("to");
    const asked = q.get("range") as Range | null;
    const range: Range = asked && RANGES.includes(asked) ? asked : "3M";
    let dateFrom: string;
    let dateTo: string;
    if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      dateFrom = from;
      dateTo = to;
    } else {
      const bounds = rangeToDateBounds(range);
      dateFrom = bounds.from ?? "2000-01-01";
      dateTo = bounds.to;
    }
    const filters = { dateFrom, dateTo };
    const allTime = dateFrom === "2000-01-01";
    if (tab === "spending") {
      const shifted = allTime ? null : shiftDateRange(dateFrom, dateTo, "back", true);
      const comp = shifted ? { dateFrom: shifted.from, dateTo: shifted.to } : undefined;
      const [rows, monthly] = await Promise.all([
        withHousehold(householdId, (tx) => getSpendingByCategory(householdId, filters, tx, comp)),
        withHousehold(householdId, (tx) => getIncomeVsExpense(householdId, filters, tx)),
      ]);
      return ok({
        dateFrom,
        dateTo,
        comparisonLabel: shifted ? comparisonLabel(shifted.from, shifted.to) : null,
        rows,
        totalIncome: monthly.reduce((a, r) => a + r.income, 0),
      });
    }
    if (tab === "income-expense") {
      const [monthly, byCategory] = await Promise.all([
        withHousehold(householdId, (tx) => getIncomeVsExpense(householdId, filters, tx)),
        withHousehold(householdId, (tx) => getIncomeExpenseByCategory(householdId, filters, tx)),
      ]);
      return ok({ dateFrom, dateTo, monthly, byCategory });
    }
    if (tab === "cash-flow") {
      const [safeToSpend, monthly] = await Promise.all([
        withHousehold(householdId, (tx) => getSafeToSpend(householdId, tx)),
        withHousehold(householdId, (tx) => getIncomeVsExpense(householdId, filters, tx)),
      ]);
      return ok({ dateFrom, dateTo, safeToSpend, monthly });
    }
    if (tab === "trends") {
      const rows = await withHousehold(householdId, (tx) => getCategoryTrends(householdId, filters, tx));
      return ok({ dateFrom, dateTo, rows });
    }
    if (tab === "net-worth") {
      const rows = await getReportNetWorthHistory(householdId, filters);
      return ok({ dateFrom, dateTo, rows });
    }
    return fail("Unknown report", 404);
  }

  if (head === "investments" && method === "GET") {
    const accIds = await getInvestmentAccountIds(householdId);
    if (id === "overview") {
      const asked = q.get("range") as Range | null;
      const range: Range = asked && RANGES.includes(asked) ? asked : "1Y";
      const { from, to } = rangeToDateBounds(range);
      const dateFrom = from ?? "1970-01-01";
      const [summary, history, allocation, reconciliation, growth] = await Promise.all([
        getPortfolioSummary(householdId, undefined, undefined, accIds),
        getPortfolioHistory(householdId, { dateFrom, dateTo: to }, undefined, accIds),
        getAssetAllocation(householdId, undefined, accIds),
        getAccountReconciliation(householdId, undefined, accIds),
        withHousehold(householdId, (tx) => getBalanceGrowth(householdId, { dateFrom, dateTo: to }, tx, accIds)),
      ]);
      return ok({ summary, history, allocation, reconciliation, growth });
    }
    if (id === "holdings") {
      const view = q.get("view") === "by-account" ? "by-account" : "consolidated";
      const rows = await getHoldings(householdId, view, q.get("accountId") ?? undefined, undefined, accIds);
      return ok(rows);
    }
    if (id === "transactions") {
      const limit = Math.min(Math.max(Number(q.get("limit")) || 40, 1), 100);
      const page = await getInvestmentTransactions(
        householdId,
        { type: q.get("type") ?? undefined, accountId: q.get("accountId") ?? undefined },
        limit,
        q.get("cursor"),
        undefined,
        accIds,
      );
      return ok(page);
    }
  }

  const fin = (r: { success: true } | { error: string } | { success: true; id: string }) =>
    "error" in r ? fail(r.error) : ok(r);

  if (head === "categories" && method !== "GET") {
    const body = (await req.json().catch(() => null)) as {
      name?: string; groupId?: string; isIncome?: boolean; excludeFromSpending?: boolean; targetId?: string;
      icon?: string | null; color?: string | null;
    } | null;
    if (id && segs[2] === "merge" && method === "POST") {
      if (!body?.targetId) return fail("Invalid input");
      return fin(await mergeCategories(id, body.targetId));
    }
    if (!id && method === "POST") {
      if (!body?.name || !body.groupId) return fail("Invalid input");
      return fin(await createCategory({
        name: body.name,
        groupId: body.groupId,
        isIncome: body.isIncome ?? false,
        includeTransferInSpending: false,
        excludeFromSpending: false,
      }));
    }
    if (id && method === "PATCH") {
      const hasIcon = !!body && "icon" in body && (body.icon === null || typeof body.icon === "string");
      const hasColor = !!body && "color" in body && (body.color === null || typeof body.color === "string");
      if (hasIcon || hasColor) {
        if (hasIcon) {
          const res = await updateCategoryIcon(id, body!.icon as string | null);
          if ("error" in res) return fail(res.error);
        }
        if (hasColor) {
          const res = await updateCategoryColor(id, body!.color as string | null);
          if ("error" in res) return fail(res.error);
        }
        return ok({ success: true });
      }
      if (body?.groupId) return fin(await moveCategoryToGroup(id, body.groupId));
      if (typeof body?.excludeFromSpending === "boolean") return fin(await updateCategoryExclusion(id, body.excludeFromSpending));
      if (!body?.name) return fail("Invalid input");
      return fin(await renameCategory(id, body.name));
    }
    if (id && method === "DELETE") return fin(await deleteCategory(id));
  }

  if (head === "category-groups") {
    const body = (await req.json().catch(() => null)) as { name?: string; targetId?: string; icon?: string | null; color?: string | null } | null;
    if (id && segs[2] === "merge" && method === "POST") {
      if (!body?.targetId) return fail("Invalid input");
      return fin(await mergeCategoryGroups(id, body.targetId));
    }
    if (!id && method === "POST") {
      if (!body?.name) return fail("Invalid input");
      return fin(await createCategoryGroup(body.name));
    }
    if (id && method === "PATCH") {
      const hasIcon = !!body && "icon" in body && (body.icon === null || typeof body.icon === "string");
      const hasColor = !!body && "color" in body && (body.color === null || typeof body.color === "string");
      if (hasIcon || hasColor) {
        if (hasIcon) {
          const res = await updateCategoryGroupIcon(id, body!.icon as string | null);
          if ("error" in res) return fail(res.error);
        }
        if (hasColor) {
          const res = await updateCategoryGroupColor(id, body!.color as string | null);
          if ("error" in res) return fail(res.error);
        }
        return ok({ success: true });
      }
      if (!body?.name) return fail("Invalid input");
      return fin(await renameCategoryGroup(id, body.name));
    }
    if (id && method === "DELETE") return fin(await deleteCategoryGroup(id));
  }

  if (head === "category-suggestions") {
    if (!id && method === "GET") {
      const ids = (q.get("ids") ?? "").split(",").filter(Boolean).slice(0, 200);
      return ok(await getCategorySuggestions(householdId, ids));
    }
    if (id && method === "PUT") {
      const body = (await req.json().catch(() => null)) as { categoryId?: string | null } | null;
      if (!body || (body.categoryId != null && typeof body.categoryId !== "string")) return fail("Invalid input");
      return fin(await setCategorySuggestion(householdId, id, body.categoryId ?? null));
    }
  }

  if (head === "category-rules") {
    if (!id && method === "GET") {
      return ok(await withHousehold(householdId, (tx) => getCategoryRules(householdId, tx)));
    }
    const body = (await req.json().catch(() => null)) as {
      categoryId?: string;
      matchField?: "name" | "merchant";
      matchPattern?: string;
      priority?: number;
    } | null;
    const input = body && {
      categoryId: body.categoryId ?? "",
      matchField: body.matchField ?? ("name" as const),
      matchPattern: body.matchPattern ?? "",
      priority: body.priority ?? 0,
    };
    if (!id && method === "POST") {
      if (!input) return fail("Invalid input");
      return fin(await createCategoryRule(input));
    }
    if (id && method === "PATCH") {
      if (!input) return fail("Invalid input");
      return fin(await updateCategoryRule({ id, ...input }));
    }
    if (id && method === "DELETE") return fin(await deleteCategoryRule(id));
  }

  if (head === "recurring") {
    if (id === "suggestions" && !segs[2] && method === "GET") {
      const rows = await withHousehold(householdId, (tx) => getRecurringSuggestions(householdId, tx));
      return ok(rows);
    }
    if (!id && method === "GET") {
      const [groups, summary] = await Promise.all([
        getRecurrings(householdId),
        withHousehold(householdId, (tx) => getRecurringSummary(householdId, tx)),
      ]);
      return ok({ groups, summary });
    }
    if (id && segs[2] === "transactions" && method === "GET") {
      const rows = await withHousehold(householdId, (tx) => getRecurringTransactions(householdId, id, tx));
      return ok(rows);
    }
    if (id && segs[2] === "rules" && method === "PUT") {
      const body = (await req.json().catch(() => null)) as {
        name?: string;
        matchName?: string;
        matchMinAmount?: number | null;
        matchMaxAmount?: number | null;
        matchDayOfMonth?: number | null;
        frequency?: string;
      } | null;
      if (!body) return fail("Invalid input");
      const result = await updateRecurringRules({
        id,
        name: body.name,
        matchName: body.matchName ?? "",
        matchMinAmount: body.matchMinAmount ?? null,
        matchMaxAmount: body.matchMaxAmount ?? null,
        matchDayOfMonth: body.matchDayOfMonth ?? null,
        frequency: body.frequency as never,
      });
      return "error" in result ? fail(String(result.error)) : ok(result);
    }
    if (id && segs[2] === "preview" && method === "GET") {
      const num = (k: string) => (q.get(k) ? Number(q.get(k)) : null);
      const rows = await withHousehold(householdId, (tx) =>
        previewRecurringMatches(
          householdId,
          id,
          {
            matchName: q.get("name"),
            matchMinAmount: num("min"),
            matchMaxAmount: num("max"),
            matchDayOfMonth: num("day"),
          },
          false,
          tx,
        ),
      );
      return ok(rows);
    }
    if (id && segs[2] === "link" && method === "POST") {
      const body = (await req.json().catch(() => null)) as { transactionId?: string } | null;
      if (!body?.transactionId) return fail("Invalid input");
      const result = await linkTransactionToRecurring(id, body.transactionId);
      return "error" in result ? fail(String(result.error)) : ok(result);
    }
    if (id && segs[2] === "link" && segs[3] && method === "DELETE") {
      const result = await unlinkTransactionFromRecurring(segs[3]);
      return "error" in result ? fail(String(result.error)) : ok(result);
    }
    if (id && !segs[2] && method === "PATCH") {
      const body = (await req.json().catch(() => null)) as { status?: "active" | "paused" | "archived" } | null;
      if (!body?.status) return fail("Invalid input");
      const result = await setRecurringStatus(id, body.status);
      return "error" in result ? fail(result.error) : ok(result);
    }
    if (!id && method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        name?: string;
        amount?: number;
        frequency?: string;
        nextDate?: string;
        matchName?: string;
        matchMinAmount?: number | null;
        matchMaxAmount?: number | null;
      } | null;
      if (!body) return fail("Invalid input");
      const result = await createRecurringTransaction({
        matchName: body.matchName,
        matchMinAmount: body.matchMinAmount,
        matchMaxAmount: body.matchMaxAmount,
        name: body.name ?? "",
        amount: body.amount ?? -1,
        frequency: body.frequency as never,
        nextDate: body.nextDate ?? "",
        categoryId: null,
        accountId: null,
      });
      return "error" in result ? fail(String(result.error)) : ok(result);
    }
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
    const body = (await req.json().catch(() => null)) as { connectionId?: string; all?: boolean } | null;
    if (body?.all === true) {
      // Connections that need a person (re-link, revoked) would only fail, so they are skipped.
      const ids = await withHousehold(householdId, (tx) =>
        tx
          .select({ id: bankConnections.id })
          .from(bankConnections)
          .where(scopedQuery(householdId, tx).where(bankConnections, inArray(bankConnections.status, ["active", "error"]))),
      );
      const results = await Promise.allSettled(ids.map((c) => triggerSync(c.id)));
      const failed = results.filter((r) => r.status === "rejected" || !r.value.success).length;
      return ok({ synced: ids.length - failed, failed });
    }
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
    if (q.get("uncategorized") === "1") { filters.categoryId = null; filters.excludeTransfers = true; }
    const exactAmount = Number(q.get("amount"));
    if (Number.isInteger(exactAmount) && exactAmount > 0) { filters.amountMin = exactAmount; filters.amountMax = exactAmount; }
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

  if (head === "transactions" && id && segs[2] === "receipts" && method === "POST") {
    let form: FormData;
    try {
      form = await req.formData();
    } catch (e) {
      return fail(`Couldn't read the upload: ${e instanceof Error ? e.message : String(e)}`);
    }
    const res = await uploadReceipt(id, form);
    return "error" in res ? fail(res.error) : ok(res.data);
  }

  if (head === "transactions" && id && segs[2] === "recurring" && (method === "POST" || method === "DELETE")) {
    if (method === "DELETE") {
      const res = await unlinkTransactionFromRecurring(id);
      if ("error" in res) return fail(res.error);
    } else {
      // Only spending can be recurring: money coming in is never tagged.
      const current = await fetchTransactionDetail(id);
      if ("error" in current) return fail(current.error, 404);
      if (current.data.normalizedAmount > 0) return fail("Only expenses can be recurring");
      // With a recurringId, join that item; without one, turn this transaction into a new recurring item.
      const body = (await req.json().catch(() => null)) as { recurringId?: string } | null;
      const res = body?.recurringId
        ? await linkTransactionToRecurring(body.recurringId, id)
        : await makeTransactionRecurring(id);
      if ("error" in res) return fail(res.error);
    }
    const detail = await fetchTransactionDetail(id);
    if ("error" in detail) return fail(detail.error, 404);
    return ok(detail.data);
  }

  if (head === "transactions" && id && method === "GET") {
    const detail = await fetchTransactionDetail(id);
    if ("error" in detail) return fail(detail.error, 404);
    const receipts = await fetchReceipts(id);
    const list = "data" in receipts ? receipts.data : [];
    // The lines read from this transaction's receipts, so the detail can show what was bought.
    const sets = (await Promise.all(list.map((r) => fetchReceiptItems(r.id)))).flatMap((r) => ("data" in r ? [r.data] : []));
    return ok({
      ...detail.data,
      receipts: list,
      items: sets.flatMap((r) => r.items),
      itemsTotalCents: sets.reduce((sum, r) => sum + r.itemsTotalCents, 0),
      itemsGapCents: sets.length === 1 ? sets[0].gapCents : null,
    });
  }

  if (head === "transactions" && id && method === "PATCH") {
    const body = (await req.json().catch(() => null)) as {
      categoryId?: string | null;
      reviewed?: boolean;
      notes?: string;
      name?: string | null;
      iconOverride?: string | null;
      iconColor?: string | null;
      isTransfer?: boolean;
    } | null;
    if (!body) return fail("Invalid input");
    const fields: { name?: string | null; iconOverride?: string | null; iconColor?: string | null; isTransfer?: boolean } = {};
    if (typeof body.isTransfer === "boolean") fields.isTransfer = body.isTransfer;
    if (typeof body.name === "string" || body.name === null) fields.name = body.name;
    if (typeof body.iconOverride === "string" || body.iconOverride === null) fields.iconOverride = body.iconOverride;
    if (typeof body.iconColor === "string" || body.iconColor === null) fields.iconColor = body.iconColor;
    if (Object.keys(fields).length > 0) {
      const res = await updateTransactionFields(id, fields);
      if ("error" in res) return fail(res.error);
    }
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

  if (head === "receipts" && id && id !== "attach" && segs[2] === "detach" && method === "POST") {
    const res = await detachReceipt(id);
    return "error" in res ? fail(res.error) : ok(res);
  }

  if (head === "receipts" && id && id !== "attach" && method === "DELETE") {
    const res = await deleteReceipt(id);
    return "error" in res ? fail(res.error) : ok(res);
  }

  if (head === "items" && id === "history" && method === "GET") {
    const key = q.get("key");
    if (!key) return fail("key is required");
    return ok(await withHousehold(householdId, (tx) => getProductPriceHistory(householdId, key, tx)));
  }

  if (head === "items" && !id && method === "GET") {
    const to = q.get("to") ?? iso(new Date());
    const from = q.get("from") ?? iso(new Date(Date.parse(`${to}T00:00:00Z`) - 90 * 86_400_000));
    const filters = { dateFrom: from, dateTo: to };
    const category = q.get("category");
    const search = q.get("q")?.slice(0, 120) || null;
    const [byCategory, products] = await Promise.all([
      withHousehold(householdId, (tx) => getItemSpendByCategory(householdId, filters, tx)),
      // Wide enough that the app can re-sort locally; search is done here, across every field.
      withHousehold(householdId, (tx) =>
        getTopProducts(householdId, { ...filters, categoryId: category || null }, 400, tx, { search }),
      ),
    ]);
    return ok({ from, to, byCategory, products });
  }

  if (head === "push") {
    const session = await getSession();
    if (!session) return fail("Unauthorized", 401);
    if (!id && method === "GET") {
      const devices = await listDevices(householdId);
      return ok({ configured: !!getApnsConfig(), devices: devices.length });
    }
    if (id === "preferences" && method === "GET") {
      return ok(await getPushPreferences(householdId));
    }
    if (id === "preferences" && method === "PATCH") {
      const patch = parsePreferencesPatch(await req.json().catch(() => null));
      if (!patch) return fail("Invalid input");
      return ok(await updatePushPreferences(householdId, patch));
    }
    if (id === "register" && method === "POST") {
      const body = (await req.json().catch(() => null)) as { token?: unknown; environment?: unknown } | null;
      const token = normalizeToken(body?.token);
      const environment = normalizeEnvironment(body?.environment);
      if (!token || !environment) return fail("Invalid input");
      await registerDevice(householdId, session.user.id, token, environment);
      return ok({ ok: true });
    }
    if (id === "register" && method === "DELETE") {
      const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
      const token = normalizeToken(body?.token ?? q.get("token"));
      if (!token) return fail("Invalid input");
      await unregisterDevice(householdId, token);
      return ok({ ok: true });
    }
    if (id === "test" && method === "POST") {
      if (!getApnsConfig()) return fail("Push isn't configured on the server (APNS_KEY_ID, APNS_TEAM_ID and a key are missing).", 503);
      const result = await notifyHousehold(householdId, {
        title: "Ledgr notifications are on",
        body: "This is a test from your NAS.",
        threadId: "test",
        data: { kind: "test" },
      });
      if (result.devices === 0) return fail("No device is registered yet. Allow notifications in the app first.", 409);
      return ok(result);
    }
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
export const PUT = guarded;
export const POST = guarded;
export const DELETE = guarded;
