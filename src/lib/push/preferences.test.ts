import { describe, expect, it } from "vitest";
import { applyPreferences, parsePreferencesPatch, type PushPreferences } from "./preferences";
import { getPushScanSettings } from "./scan-settings";

describe("parsePreferencesPatch", () => {
  it("accepts a partial, valid patch", () => {
    expect(parsePreferencesPatch({ bills: false, largeChargeCents: 50000, quietStartHour: 22 })).toEqual({
      bills: false,
      largeChargeCents: 50000,
      quietStartHour: 22,
    });
  });
  it("rejects wrong types and out-of-range values", () => {
    expect(parsePreferencesPatch(null)).toBeNull();
    expect(parsePreferencesPatch({ bills: "yes" })).toBeNull();
    expect(parsePreferencesPatch({ largeChargeCents: 5 })).toBeNull();
    expect(parsePreferencesPatch({ largeChargeCents: 12.5 })).toBeNull();
    expect(parsePreferencesPatch({ quietEndHour: 24 })).toBeNull();
  });
  it("ignores unknown keys", () => {
    expect(parsePreferencesPatch({ hack: 1 })).toEqual({});
  });
});

describe("applyPreferences", () => {
  const prefs: PushPreferences = {
    enabled: true,
    deposits: false,
    depositCents: 50000,
    review: false,
    weekly: false,
    bills: true,
    largeCharges: false,
    budgets: true,
    connections: true,
    lowBalance: true,
    lowBalanceCents: 20000,
    largeChargeCents: 10000,
    quietEnabled: true,
    quietStartHour: 22,
    quietEndHour: 7,
  };
  it("overrides threshold, hours and types", () => {
    const s = applyPreferences(getPushScanSettings({}), prefs);
    expect(s).toMatchObject({ largeTxnCents: 10000, quietStartHour: 22, quietEndHour: 7 });
    expect(s.types.largeCharges).toBe(false);
  });
  it("turning quiet hours off leaves an empty window", () => {
    const s = applyPreferences(getPushScanSettings({}), { ...prefs, quietEnabled: false });
    expect(s.quietStartHour).toBe(s.quietEndHour);
  });
});
