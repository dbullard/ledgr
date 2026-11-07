/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PortfolioSummaryHeader } from "./portfolio-summary-header";
import type { PortfolioSummary } from "@/queries/investments";

const base: PortfolioSummary = {
  totalValue: 3200750,
  holdingsValue: 3200750,
  cashValue: 0,
  dayChange: null,
  totalGainLoss: 0,
  totalCostBasis: 0,
  gainLossCoverage: 0,
};

describe("PortfolioSummaryHeader gain/loss", () => {
  it("says n/a, not +$0.00, when no holding reports a cost basis", () => {
    render(<PortfolioSummaryHeader summary={base} />);
    const tile = screen.getByText("Gain/Loss (with cost basis)").parentElement!;
    expect(tile.textContent).toContain("n/a");
    expect(tile.textContent).not.toContain("$0.00");
  });

  it("shows the figure when some holdings do have a basis", () => {
    render(<PortfolioSummaryHeader summary={{ ...base, totalGainLoss: 20000, totalCostBasis: 80000, gainLossCoverage: 100000 }} />);
    const tile = screen.getByText("Gain/Loss (with cost basis)").parentElement!;
    expect(tile.textContent).toContain("$200.00");
  });
});
