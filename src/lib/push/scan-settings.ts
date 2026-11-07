export interface PushScanSettings {
  /** Charges at or above this many cents are "large". */
  largeTxnCents: number;
  /** No notifications before this local hour (0-23)... */
  quietEndHour: number;
  /** ...or from this local hour on. */
  quietStartHour: number;
  /** Individual notifications per scan before the rest are folded into one. */
  maxIndividual: number;
  /** Which kinds of notification are switched on. */
  types: { bills: boolean; largeCharges: boolean; budgets: boolean; connections: boolean };
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
    types: { bills: true, largeCharges: true, budgets: true, connections: true },
  };
}

export function isQuietHour(hour: number, s: Pick<PushScanSettings, "quietEndHour" | "quietStartHour">): boolean {
  if (s.quietStartHour === s.quietEndHour) return false;
  return s.quietStartHour > s.quietEndHour
    ? hour >= s.quietStartHour || hour < s.quietEndHour // e.g. 21:00 → 08:00
    : hour >= s.quietStartHour && hour < s.quietEndHour;
}
