import { StatStrip, type StatStripItem } from "@/components/molecules/stat-strip";
import { centsToDisplay, centsToSignedDisplay } from "@/lib/money";
import { formatDateShort } from "@/lib/date-utils";
import type { BalanceGrowth } from "@/queries/investments";

interface BalanceGrowthStripProps {
  growth: BalanceGrowth;
}

/**
 * For accounts whose connector reports only a balance: what the value did
 * since Ledgr started recording it, split into money put in and what the
 * account grew beyond that. Growth is balance change less recorded flows, so
 * it is an estimate -- flows Ledgr never saw are counted as growth.
 */
export function BalanceGrowthStrip({ growth }: BalanceGrowthStripProps) {
  const items: StatStripItem[] = [
    { label: `Value now (since ${formatDateShort(growth.since)})`, value: centsToDisplay(growth.endValue) },
    { label: "Net contributions", value: centsToSignedDisplay(growth.netContributions) },
    {
      label: "Growth beyond contributions (est.)",
      value: centsToSignedDisplay(growth.growth),
      valueClassName: growth.growth >= 0 ? "text-positive" : "text-destructive",
    },
  ];
  return <StatStrip items={items} />;
}
