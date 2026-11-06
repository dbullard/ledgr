"use server";

import { eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db as defaultDb, type LedgrDb } from "@/db";
import { accounts } from "@/db/schema";
import { authorizeAction } from "@/lib/auth/authorize-action";
import { getHouseholdId } from "@/lib/auth/session";
import { scopedQuery } from "@/lib/scoped-query";
import { getInvestmentTransactions, type InvestmentFilters } from "@/queries/investments";

export async function loadMoreInvestmentTransactions(
  cursor: string,
  filters: InvestmentFilters = {},
) {
  const householdId = await getHouseholdId();
  return getInvestmentTransactions(householdId, filters, 50, cursor);
}

type ActionResult = { success: true } | { error: string };

const fundSchema = z.object({
  ticker: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9.\-]{1,12}$/, "Enter a ticker such as GMGZX."),
  name: z.string().trim().max(80).optional(),
});

/**
 * Says an investment account is a single fund, or (null) clears that. Used when
 * a connector reports a balance but no holdings: Investments then shows the
 * account as one mutual-fund position worth its balance. A connector that does
 * send holdings overrides this, so setting it is always safe.
 */
export async function setAccountFundScoped(
  householdId: string,
  accountId: string,
  input: { ticker: string; name?: string } | null,
  db: LedgrDb = defaultDb,
): Promise<ActionResult> {
  const parsedId = z.string().min(1).safeParse(accountId);
  if (!parsedId.success) return { error: "Invalid input." };

  let values: { fundTicker: string | null; fundName: string | null };
  if (input === null) {
    values = { fundTicker: null, fundName: null };
  } else {
    const parsed = fundSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
    values = { fundTicker: parsed.data.ticker, fundName: parsed.data.name || null };
  }

  const scoped = scopedQuery(householdId, db);
  const updated = await db
    .update(accounts)
    .set({ ...values, updatedAt: new Date() })
    .where(
      scoped.where(
        accounts,
        eq(accounts.id, parsedId.data),
        eq(accounts.type, "investment"),
        isNull(accounts.deletedAt),
      ),
    )
    .returning({ id: accounts.id });
  if (updated.length === 0) return { error: "Only investment accounts can be itemized as a fund." };

  for (const path of ["/investments", "/accounts", "/"]) revalidatePath(path);
  return { success: true };
}

export async function setAccountFund(
  accountId: string,
  input: { ticker: string; name?: string } | null,
): Promise<ActionResult> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return setAccountFundScoped(auth.householdId, accountId, input);
}
