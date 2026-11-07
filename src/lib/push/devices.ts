import { and, eq } from "drizzle-orm";
import { db as defaultDb, type LedgrDb } from "@/db";
import { pushDevices } from "@/db/schema";
import { withHousehold } from "@/lib/household-context";
import type { ApnsEnvironment } from "./apns";

export interface PushDevice {
  id: string;
  userId: string;
  token: string;
  environment: ApnsEnvironment;
}

const TOKEN_RE = /^[0-9a-f]{32,200}$/;

/** APNs tokens are hex. Normalises case; returns null for anything else. */
export function normalizeToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase();
  return TOKEN_RE.test(t) ? t : null;
}

export function normalizeEnvironment(raw: unknown): ApnsEnvironment | null {
  return raw === "sandbox" || raw === "production" ? raw : null;
}

export async function registerDevice(
  householdId: string,
  userId: string,
  token: string,
  environment: ApnsEnvironment,
  db: LedgrDb = defaultDb,
): Promise<void> {
  await withHousehold(
    householdId,
    (tx) =>
      tx
        .insert(pushDevices)
        .values({ id: crypto.randomUUID(), householdId, userId, token, environment })
        .onConflictDoUpdate({
          target: [pushDevices.householdId, pushDevices.token],
          set: { userId, environment, updatedAt: new Date() },
        }),
    db,
  );
}

export async function unregisterDevice(
  householdId: string,
  token: string,
  db: LedgrDb = defaultDb,
): Promise<void> {
  await withHousehold(
    householdId,
    (tx) => tx.delete(pushDevices).where(and(eq(pushDevices.householdId, householdId), eq(pushDevices.token, token))),
    db,
  );
}

export async function listDevices(householdId: string, db: LedgrDb = defaultDb): Promise<PushDevice[]> {
  return withHousehold(
    householdId,
    (tx) =>
      tx
        .select({
          id: pushDevices.id,
          userId: pushDevices.userId,
          token: pushDevices.token,
          environment: pushDevices.environment,
        })
        .from(pushDevices)
        .where(eq(pushDevices.householdId, householdId)),
    db,
  );
}

export async function setDeviceEnvironment(
  householdId: string,
  deviceId: string,
  environment: ApnsEnvironment,
  db: LedgrDb = defaultDb,
): Promise<void> {
  await withHousehold(
    householdId,
    (tx) =>
      tx
        .update(pushDevices)
        .set({ environment, updatedAt: new Date() })
        .where(and(eq(pushDevices.householdId, householdId), eq(pushDevices.id, deviceId))),
    db,
  );
}

export async function deleteDeviceById(
  householdId: string,
  deviceId: string,
  db: LedgrDb = defaultDb,
): Promise<void> {
  await withHousehold(
    householdId,
    (tx) => tx.delete(pushDevices).where(and(eq(pushDevices.householdId, householdId), eq(pushDevices.id, deviceId))),
    db,
  );
}
