"use server";

import { v4 as uuid } from "uuid";
import { eq, and, isNotNull, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { Products, CountryCode } from "plaid";
import { getPlaidClient } from "@/lib/plaid/client";
import { encrypt, decrypt } from "@/lib/encryption";
import { plaidAmountToCents, plaidBalanceToCents } from "@/lib/money";
import { mapPlaidAccountType, extractPlaidErrorCode, extractPlaidErrorMessage, describePlaidErrorForLog } from "@/lib/plaid/utils";
import { todayDateString } from "@/lib/date-utils";
import { getHouseholdId } from "@/lib/auth/session";
import { authorizeAction } from "@/lib/auth/authorize-action";
import { db as defaultDb, type LedgrDb } from "@/db";
import { bankConnections, accounts, balanceHistory, institutionLogos } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { syncInstitution } from "@/lib/plaid/sync";
import { syncInvestments } from "@/lib/plaid/investments";

export async function createLinkToken() {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;

  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    return {
      error:
        "Plaid isn't set up on this server. Add PLAID_CLIENT_ID and PLAID_SECRET, or connect through SimpleFIN instead.",
    };
  }

  try {
    const response = await getPlaidClient().linkTokenCreate({
      user: { client_user_id: auth.userId },
      client_name: "Ledgr",
      products: [Products.Transactions],
      optional_products: [Products.Investments],
      country_codes: [CountryCode.Us],
      language: "en",
      ...(process.env.PLAID_WEBHOOK_URL
        ? { webhook: process.env.PLAID_WEBHOOK_URL }
        : {}),
      ...(process.env.PLAID_OAUTH_REDIRECT_URI
        ? { redirect_uri: process.env.PLAID_OAUTH_REDIRECT_URI }
        : {}),
    });
    return { linkToken: response.data.link_token };
  } catch (e: unknown) {
    console.error("Failed to create link token:", describePlaidErrorForLog(e));
    return { error: extractPlaidErrorMessage(e) ?? "Failed to initialize bank connection" };
  }
}

export async function exchangeAndStoreAccounts(
  publicToken: string,
  householdId: string,
  db: LedgrDb = defaultDb
): Promise<
  | { success: true; accountCount: number; plaidItemId: string; error?: never }
  | { success: false; error: string; accountCount?: never; plaidItemId?: never }
> {
  const auth = await authorizeAction();
  if ("error" in auth) return { success: false, error: auth.error };

  try {
    const exchangeRes = await getPlaidClient().itemPublicTokenExchange({
      public_token: publicToken,
    });
    const accessToken = exchangeRes.data.access_token;

    const itemRes = await getPlaidClient().itemGet({ access_token: accessToken });
    const institutionId = itemRes.data.item.institution_id ?? null;

    let institutionName = "Unknown Institution";
    let institutionLogo: string | null = null;
    let institutionPrimaryColor: string | null = null;
    if (institutionId) {
      try {
        const instRes = await getPlaidClient().institutionsGetById({
          institution_id: institutionId,
          country_codes: [CountryCode.Us],
          options: { include_optional_metadata: true },
        });
        institutionName = instRes.data.institution.name;
        institutionLogo = instRes.data.institution.logo ?? null;
        institutionPrimaryColor = instRes.data.institution.primary_color ?? null;
      } catch {
        // Fall back to "Unknown Institution" if lookup fails
      }
    }

    const accountsRes = await getPlaidClient().accountsGet({
      access_token: accessToken,
    });
    const plaidAccounts = accountsRes.data.accounts;

    // One household can legitimately hold several logins at the same bank (two
    // spouses at one credit union), so "same institution" is not a duplicate.
    // It is a duplicate only when this Item adds nothing: every account in it
    // (matched by subtype + last four) already belongs to a connection we hold
    // at that institution. Anything we cannot prove is a duplicate is allowed.
    if (institutionId) {
      const existingHere = await db
        .select({ id: bankConnections.id, credential: bankConnections.credential })
        .from(bankConnections)
        .where(
          and(
            eq(bankConnections.householdId, householdId),
            eq(bankConnections.plaidInstitutionId, institutionId)
          )
        );
      const accountKey = (a: { subtype?: string | null; mask?: string | null }) =>
        a.mask ? `${a.subtype ?? ""}:${a.mask}` : null;
      const newKeys = plaidAccounts.map(accountKey);
      if (existingHere.length > 0 && newKeys.length > 0 && newKeys.every((k) => k !== null)) {
        const known = new Set<string>();
        for (const conn of existingHere) {
          try {
            const res = await getPlaidClient().accountsGet({ access_token: decrypt(conn.credential) });
            for (const a of res.data.accounts) {
              const k = accountKey(a);
              if (k) known.add(k);
            }
          } catch (e) {
            console.error("[plaid] could not list accounts for duplicate check:", describePlaidErrorForLog(e));
          }
        }
        if (newKeys.every((k) => k !== null && known.has(k))) {
          // Stop tracking the redundant Item at Plaid rather than leaving it orphaned.
          await getPlaidClient()
            .itemRemove({ access_token: accessToken })
            .catch((e) => console.error("[plaid] could not remove duplicate item:", describePlaidErrorForLog(e)));
          return { success: false, error: "This institution is already connected" };
        }
      }
    }

    const plaidItemId = uuid();
    const today = todayDateString();

    await db.transaction(async (tx) => {
      await tx.insert(bankConnections)
        .values({
          id: plaidItemId,
          householdId,
          provider: "plaid",
          credential: encrypt(accessToken),
          plaidInstitutionId: institutionId,
          plaidItemId: itemRes.data.item.item_id,
          institutionName,
          primaryColor: institutionPrimaryColor,
          status: "active",
        });

      if (institutionLogo) {
        await tx.insert(institutionLogos)
          .values({
            id: uuid(),
            connectionId: plaidItemId,
            logo: institutionLogo,
          });
      }

      for (const acct of plaidAccounts) {
        const accountType = mapPlaidAccountType(acct.type, acct.subtype ?? null);
        const accountFields = {
          name: acct.name,
          officialName: acct.official_name ?? null,
          type: accountType,
          subtype: acct.subtype ?? null,
          // Plaid reports credit/loan balances positive when owed; Ledgr
          // stores owed as negative. See db/schema/accounts.ts.
          currentBalance: plaidBalanceToCents(acct.balances.current ?? null, accountType),
          availableBalance: plaidAmountToCents(acct.balances.available ?? null),
          creditLimit: plaidAmountToCents(acct.balances.limit ?? null),
          currency: acct.balances.iso_currency_code ?? "USD",
        };

        const [existingDeleted] = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(
            and(
              eq(accounts.externalAccountId, acct.account_id),
              eq(accounts.householdId, householdId),
              isNotNull(accounts.deletedAt),
            ),
          )
          .orderBy(desc(accounts.deletedAt))
          .limit(1);

        let accountId: string;

        if (existingDeleted) {
          accountId = existingDeleted.id;
          await tx.update(accounts)
            .set({ ...accountFields, deletedAt: null, bankConnectionId: plaidItemId, updatedAt: new Date() })
            .where(eq(accounts.id, existingDeleted.id));
          console.log(`[plaid] Resurrected account ${accountId} (plaid: ${acct.account_id})`);
        } else {
          accountId = uuid();
          await tx.insert(accounts)
            .values({
              id: accountId,
              householdId,
              bankConnectionId: plaidItemId,
              externalAccountId: acct.account_id,
              ...accountFields,
            });
          console.log(`[plaid] Created new account ${accountId} (plaid: ${acct.account_id})`);
        }

        if (accountFields.currentBalance !== null) {
          await tx.insert(balanceHistory)
            .values({
              id: uuid(),
              accountId,
              date: today,
              balance: accountFields.currentBalance,
            })
            .onConflictDoUpdate({
              target: [balanceHistory.accountId, balanceHistory.date],
              set: { balance: accountFields.currentBalance },
            });
        }
      }
    });

    return { success: true, accountCount: plaidAccounts.length, plaidItemId };
  } catch (e: unknown) {
    console.error("Exchange failed:", describePlaidErrorForLog(e));
    const errorCode = extractPlaidErrorCode(e);
    if (
      errorCode === "INSTITUTION_DOWN" ||
      errorCode === "INSTITUTION_NOT_RESPONDING"
    ) {
      return {
        success: false,
        error: "This bank is temporarily unavailable. Please try again later.",
      };
    }
    return { success: false, error: "Failed to connect account" };
  }
}

export async function exchangePublicToken(publicToken: string) {
  const householdId = await getHouseholdId();
  const result = await exchangeAndStoreAccounts(publicToken, householdId);
  if (result.success && result.plaidItemId) {
    const itemId = result.plaidItemId;
    try {
      await syncInstitution(itemId, householdId, defaultDb);
      syncInvestments(itemId, householdId, defaultDb).catch(() => {});
    } catch (err) {
      console.error("[plaid] Auto-sync after link failed:", describePlaidErrorForLog(err));
    }
    revalidatePath("/");
    revalidatePath("/accounts");
    revalidatePath("/transactions");
    revalidatePath("/investments");
  }
  return result;
}

export async function disconnectPlaidItem(
  plaidItemId: string,
  db: LedgrDb = defaultDb,
) {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  const { householdId } = auth;

  const scoped = scopedQuery(householdId, db);

  const [item] = await db
    .select({
      id: bankConnections.id,
      credential: bankConnections.credential,
    })
    .from(bankConnections)
    .where(scoped.where(bankConnections, eq(bankConnections.id, plaidItemId)))
    .limit(1);

  if (!item) {
    return { error: "Item not found" };
  }

  try {
    await getPlaidClient().itemRemove({
      access_token: decrypt(item.credential),
    });
  } catch {
    // Best-effort — continue with local cleanup even if Plaid call fails
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(accounts)
      .set({ deletedAt: now, bankConnectionId: null })
      .where(eq(accounts.bankConnectionId, plaidItemId));

    await tx.delete(bankConnections)
      .where(eq(bankConnections.id, plaidItemId));
  });

  revalidatePath("/accounts");
  revalidatePath("/investments");
  return { success: true };
}
