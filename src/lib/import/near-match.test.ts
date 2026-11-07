import { describe, it, expect } from "vitest";
import { matchNearDuplicates } from "./near-match";

describe("matchNearDuplicates", () => {
  it("matches the same amount posted a day apart (bank export vs aggregator date)", () => {
    const m = matchNearDuplicates(
      [{ key: "n1", date: "2026-11-03", amount: -4250 }],
      [{ key: "e1", date: "2026-11-02", amount: -4250 }],
    );
    expect(m.get("n1")).toBe("e1");
  });

  it("does not match different amounts or dates beyond the window", () => {
    const m = matchNearDuplicates(
      [{ key: "n1", date: "2026-11-10", amount: -4250 }, { key: "n2", date: "2026-11-03", amount: -4251 }],
      [{ key: "e1", date: "2026-11-02", amount: -4250 }],
    );
    expect(m.size).toBe(0);
  });

  it("is one-to-one: two identical coffees need two existing rows", () => {
    const m = matchNearDuplicates(
      [{ key: "n1", date: "2026-11-03", amount: -500 }, { key: "n2", date: "2026-11-03", amount: -500 }],
      [{ key: "e1", date: "2026-11-03", amount: -500 }],
    );
    expect(m.size).toBe(1);
  });

  it("prefers the closest date when several existing rows qualify", () => {
    const m = matchNearDuplicates(
      [{ key: "n1", date: "2026-11-05", amount: -900 }],
      [{ key: "far", date: "2026-11-02", amount: -900 }, { key: "near", date: "2026-11-05", amount: -900 }],
    );
    expect(m.get("n1")).toBe("near");
  });
});
