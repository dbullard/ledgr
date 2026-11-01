"use client";

import { Line, LineChart, XAxis, YAxis, CartesianGrid } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { centsToDisplay, centsToCompact } from "@/lib/money";
import { formatMonthShort } from "@/lib/date-utils";
import { PRIMARY_COLOR } from "@/lib/chart-colors";
import type { MonthPoint } from "@/lib/recurring-history";

const chartConfig = {
  actual: { label: "Paid", color: PRIMARY_COLOR },
  projection: { label: "Expected", color: PRIMARY_COLOR },
} satisfies ChartConfig;

/** Monthly spend on one recurring item; the upcoming payment is dotted. */
export function RecurringHistoryChart({ points }: { points: MonthPoint[] }) {
  const data = points.map((p, i) => ({
    month: p.month,
    actual: p.projected ? null : p.amount,
    // The dotted segment starts at the last real point so the two lines join.
    projection: p.projected || points[i + 1]?.projected ? p.amount : null,
  }));
  const yearOf = (month: string) => month.slice(0, 4);

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-40 w-full">
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="month"
          tickFormatter={(m: string, i: number) =>
            i === 0 || m.endsWith("-01") ? `${formatMonthShort(m)} ${yearOf(m)}` : formatMonthShort(m)
          }
          tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
          minTickGap={12}
        />
        <YAxis
          tickFormatter={centsToCompact}
          tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
          width={40}
          axisLine={false}
          tickLine={false}
          tickCount={3}
          domain={[0, "auto"]}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(label) => `${formatMonthShort(String(label))} ${yearOf(String(label))}`}
              valueFormatter={(v) => centsToDisplay(Number(v))}
            />
          }
        />
        <Line type="linear" dataKey="actual" stroke="var(--color-actual)" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
        <Line
          type="linear"
          dataKey="projection"
          stroke="var(--color-projection)"
          strokeWidth={2}
          strokeDasharray="3 4"
          dot={false}
          activeDot={{ r: 3 }}
          connectNulls={false}
        />
      </LineChart>
    </ChartContainer>
  );
}
