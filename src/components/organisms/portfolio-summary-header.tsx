import { centsToDisplay, centsToSignedDisplay } from "@/lib/money";
import { StatStrip, type StatStripItem } from "@/components/molecules/stat-strip";
import type { PortfolioSummary } from "@/queries/investments";

interface PortfolioSummaryHeaderProps {
  summary: PortfolioSummary;
}

export function PortfolioSummaryHeader({ summary }: PortfolioSummaryHeaderProps) {
  const items: StatStripItem[] = [
    { label: "Total Portfolio", value: centsToDisplay(summary.totalValue) },
  ];

  // Only worth a column when there is a gap to explain. Showing a permanent
  // "$0.00" cash tile would spend a quarter of the strip on nothing.
  if (summary.cashValue > 0) {
    items.push({
      label: "Cash / Unallocated",
      value: centsToDisplay(summary.cashValue),
    });
  }

  items.push(
    {
      // Derived from holdings_history, so it can only ever describe the
      // itemized part. The label says so rather than implying whole-portfolio.
      label: "Day Change (holdings)",
      value: summary.dayChange !== null ? centsToSignedDisplay(summary.dayChange) : "n/a",
      valueClassName:
        summary.dayChange !== null
          ? summary.dayChange >= 0
            ? "text-positive"
            : "text-destructive"
          : undefined,
    },
    {
      // Spans only holdings that report a cost basis. Zero-basis positions
      // would otherwise contribute their entire value as gain.
      label: "Gain/Loss (with cost basis)",
      // With no cost basis anywhere there is nothing to compare against, so say
      // so instead of a green "+$0.00" that reads as "no change".
      value: summary.gainLossCoverage > 0 ? centsToSignedDisplay(summary.totalGainLoss) : "n/a",
      valueClassName:
        summary.gainLossCoverage > 0
          ? summary.totalGainLoss >= 0
            ? "text-positive"
            : "text-destructive"
          : undefined,
    },
  );

  return <StatStrip items={items} />;
}
