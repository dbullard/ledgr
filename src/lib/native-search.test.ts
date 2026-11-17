import { describe, it, expect } from "vitest";
import { matches } from "./native-search";

describe("native search matches", () => {
  it("ignores case", () => {
    expect(matches("whole", "WHOLE FOODS")).toBe(true);
  });

  it("matches on any field", () => {
    expect(matches("vti", "Vanguard Total Market", "VTI")).toBe(true);
  });

  it("skips empty and missing fields", () => {
    expect(matches("x", null, undefined, "")).toBe(false);
  });

  it("does not match unrelated text", () => {
    expect(matches("rent", "Groceries")).toBe(false);
  });
});
