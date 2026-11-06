"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Button } from "@/components/ui/button";
import { centsToDisplay, centsToCompact } from "@/lib/money";
import { INCOME_COLOR, SPENDING_COLOR } from "@/lib/chart-colors";
import { trendBucketLabel as label } from "@/lib/trend-bucket";
import type { TrendBucket, TrendGranularity } from "@/queries/transactions";

const OPTIONS: { value: TrendGranularity; label: string }[] = [
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
  { value: "5y", label: "5 years" },
];

const chartConfig = {
  income: { label: "Credits", color: INCOME_COLOR },
  expenses: { label: "Spending", color: SPENDING_COLOR },
} satisfies ChartConfig;

interface Props {
  data: TrendBucket[];
  granularity: TrendGranularity;
  /** Bucket key of the bar the list below is narrowed to, if any. */
  selected?: string;
}

export function TransactionTrendChart({ data, granularity, selected }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function select(g: TrendGranularity) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("by", g);
    next.delete("bucket"); // a bucket key only means something at its own granularity
    startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
  }

  // Clicking anywhere in a bucket's column (the bars are thin) narrows the list
  // to it; clicking the selected bucket again clears the narrowing.
  function pick(state: { activeIndex?: number | string | null } | undefined) {
    const index = Number(state?.activeIndex);
    const period = Number.isInteger(index) ? data[index]?.period : undefined;
    if (!period) return;
    const next = new URLSearchParams(searchParams.toString());
    if (period === selected) next.delete("bucket");
    else next.set("bucket", period);
    startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
  }

  function clear() {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("bucket");
    startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
  }

  return (
    <div className="rounded-lg border border-border/60 px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          Spending and credits over time
          {selected && (
            <>
              {" · "}
              <span className="text-foreground">{label(selected, granularity, true)}</span>{" "}
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={clear}>
                Clear
              </button>
            </>
          )}
        </span>
        <div className="flex gap-1" role="group" aria-label="Group by">
          {OPTIONS.map((o) => (
            <Button
              key={o.value}
              size="sm"
              variant={o.value === granularity ? "secondary" : "ghost"}
              aria-pressed={o.value === granularity}
              onClick={() => select(o.value)}
            >
              {o.label}
            </Button>
          ))}
        </div>
      </div>
      <div className={`h-48 transition-opacity ${pending ? "opacity-50" : ""}`}>
        {data.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No transactions to chart.
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="aspect-auto h-full w-full cursor-pointer">
            <BarChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }} onClick={pick}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis
                dataKey="period"
                tickFormatter={(p) => label(String(p), granularity, false)}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis
                tickFormatter={centsToCompact}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                width={44}
                axisLine={false}
                tickLine={false}
                tickCount={4}
              />
              <ChartTooltip
                cursor={{ fill: "var(--muted)", opacity: 0.4 }}
                content={
                  <ChartTooltipContent
                    labelFormatter={(p) => label(String(p), granularity, true)}
                    valueFormatter={(v) => centsToDisplay(Number(v))}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="income" fill="var(--color-income)" radius={[4, 4, 0, 0]} maxBarSize={24}>
                {data.map((b) => (
                  <Cell key={b.period} fillOpacity={selected && b.period !== selected ? 0.35 : 1} />
                ))}
              </Bar>
              <Bar dataKey="expenses" fill="var(--color-expenses)" radius={[4, 4, 0, 0]} maxBarSize={24}>
                {data.map((b) => (
                  <Cell key={b.period} fillOpacity={selected && b.period !== selected ? 0.35 : 1} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </div>
    </div>
  );
}
