import { db as defaultDb, type LedgrDb } from "@/db";
import {
  getApnsConfig,
  sendApns,
  type ApnsConfig,
  type ApnsResult,
  type PushMessage,
} from "./apns";
import { deleteDeviceById, listDevices, setDeviceEnvironment, type PushDevice } from "./devices";

export interface NotifyResult {
  /** False when APNs isn't configured; nothing was attempted. */
  configured: boolean;
  devices: number;
  sent: number;
  failed: number;
  pruned: number;
}

export interface NotifyDeps {
  db?: LedgrDb;
  config?: ApnsConfig | null;
  send?: (config: ApnsConfig, device: PushDevice, message: PushMessage) => Promise<ApnsResult>;
}

/**
 * Pushes one message to every registered device in the household. Devices APNs
 * reports as gone are removed; devices that only worked on the other APNs host
 * get their stored environment corrected. Never throws.
 */
export async function notifyHousehold(
  householdId: string,
  message: PushMessage,
  deps: NotifyDeps = {},
): Promise<NotifyResult> {
  const db = deps.db ?? defaultDb;
  const config = deps.config === undefined ? getApnsConfig() : deps.config;
  const result: NotifyResult = { configured: !!config, devices: 0, sent: 0, failed: 0, pruned: 0 };
  if (!config) return result;

  const send = deps.send ?? ((c, d, m) => sendApns(c, d, m));
  const devices = await listDevices(householdId, db);
  result.devices = devices.length;

  for (const device of devices) {
    try {
      const res = await send(config, device, message);
      if (res.ok) {
        result.sent++;
        if (res.environment !== device.environment) {
          await setDeviceEnvironment(householdId, device.id, res.environment, db);
        }
      } else if (res.invalidToken) {
        await deleteDeviceById(householdId, device.id, db);
        result.pruned++;
      } else {
        result.failed++;
        console.warn(`[push] APNs rejected a notification: ${res.status} ${res.reason}`);
      }
    } catch (err) {
      result.failed++;
      console.warn("[push] send failed:", (err as Error).message);
    }
  }
  return result;
}
