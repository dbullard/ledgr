import { describe, expect, it } from "vitest";
import { CHART_COLORS } from "@/lib/chart-colors";
import { categoryTone, categoryToneStyle } from "./category-tone";

describe("categoryTone", () => {
  it("is stable for the same name regardless of case and padding", () => {
    expect(categoryTone("Groceries")).toBe(categoryTone("  groceries "));
  });

  it("returns a palette colour for named categories", () => {
    expect(CHART_COLORS).toContain(categoryTone("Restaurants"));
  });

  it("uses the neutral for missing names", () => {
    expect(categoryTone(null)).toBe("var(--chart-neutral)");
    expect(categoryTone("")).toBe("var(--chart-neutral)");
  });

  it("builds a tinted style from the tone", () => {
    const style = categoryToneStyle("Coffee");
    expect(style.color).toBe(categoryTone("Coffee"));
    expect(String(style.backgroundColor)).toContain("color-mix");
  });
});
