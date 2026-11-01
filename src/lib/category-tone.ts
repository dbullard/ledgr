import type { CSSProperties } from "react";
import { CHART_COLORS } from "@/lib/chart-colors";

/**
 * Stable chart colour for a category name. The same name always lands on the
 * same palette slot, so "Groceries" is the same colour on the dashboard, in
 * the transaction list and in the bills widget without a lookup table.
 * Unnamed categories get the neutral.
 */
export function categoryTone(name: string | null | undefined): string {
  if (!name) return "var(--chart-neutral)";
  let hash = 2166136261;
  for (const ch of name.trim().toLowerCase()) {
    hash = Math.imul(hash ^ ch.codePointAt(0)!, 16777619) >>> 0;
  }
  return CHART_COLORS[hash % CHART_COLORS.length];
}

/** Tinted-pill style: the tone for text, a faint wash of it for the fill. */
export function categoryToneStyle(name: string | null | undefined): CSSProperties {
  const tone = categoryTone(name);
  return {
    color: tone,
    backgroundColor: `color-mix(in oklab, ${tone} 16%, transparent)`,
  };
}
