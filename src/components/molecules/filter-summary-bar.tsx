import { centsToDisplay, centsToSignedDisplay } from "@/lib/money";

interface FilterSummaryBarProps {
  count: number;
  totalExpense: number;
  totalIncome: number;
  net: number;
  firstDate: string | null;
  lastDate: string | null;
  largestExpense: number;
  pendingCount: number;
  pendingAmount: number;
  transferCount: number;
  transferAmount: number;
}

const DAY_MS = 86_400_000;

function formatShort(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Inclusive day span between two YYYY-MM-DD dates (UTC math, so DST can't skew it).
function daySpan(first: string, last: string): number {
  const toUtc = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.max(1, Math.round((toUtc(last) - toUtc(first)) / DAY_MS) + 1);
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "positive" }) {
  return (
    <div className="min-w-[8.5rem] flex-1 rounded-lg border border-border/60 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${tone === "positive" ? "text-positive" : "text-foreground"}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground tabular-nums">{sub}</div>}
    </div>
  );
}

export function FilterSummaryBar({
  count,
  totalExpense,
  totalIncome,
  net,
  firstDate,
  lastDate,
  largestExpense,
  pendingCount,
  pendingAmount,
  transferCount,
  transferAmount,
}: FilterSummaryBarProps) {
  const label = `${count} transaction${count !== 1 ? "s" : ""}`;
  // Math.abs() here used to swallow the minus, so a net of -$248 read as
  // "$248" — a loss shown as a gain to anyone not reading the color.
  const netText = centsToSignedDisplay(net);
  const days = firstDate && lastDate ? daySpan(firstDate, lastDate) : 0;
  const avgPerDay = days > 0 ? Math.round(totalExpense / days) : 0;
  const savingsRate = totalIncome > 0 ? Math.round((Math.abs(net) / totalIncome) * 100) : null;

  return (
    <>
      {/*
        Below sm the four figures and three separators wrap to two lines, which
        puts Net — the number the strip exists for — last, on the second line.
        One line instead, net first; expenses and credits return at sm, where
        the full strip fits on one line anyway.
      */}
      <div className="flex items-center gap-x-2 px-2 py-1.5 text-sm text-muted-foreground sm:hidden">
        <span className={net >= 0 ? "text-positive" : ""}>
          Net <span className="tabular-nums">{netText}</span>
        </span>
        <span className="text-border">·</span>
        <span className="truncate">{label}</span>
      </div>

      <div className="hidden space-y-2 px-2 py-1.5 sm:block">
        <div className="flex flex-wrap gap-x-2 text-sm text-muted-foreground">
          <span>{label}</span>
          {firstDate && lastDate && (
            <span>
              · {firstDate === lastDate ? formatShort(firstDate) : `${formatShort(firstDate)} – ${formatShort(lastDate)}`}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Stat label="Expenses" value={centsToDisplay(totalExpense)} sub={avgPerDay ? `${centsToDisplay(avgPerDay)}/day` : undefined} />
          <Stat label="Credits" value={`+${centsToDisplay(totalIncome)}`} tone="positive" />
          <Stat
            label="Net"
            value={netText}
            tone={net >= 0 ? "positive" : undefined}
            sub={savingsRate !== null ? `${savingsRate}% of credits ${net >= 0 ? "kept" : "overspent"}` : undefined}
          />
          {largestExpense > 0 && <Stat label="Largest expense" value={centsToDisplay(largestExpense)} />}
          {transferCount > 0 && (
            <Stat label="Transfers" value={centsToDisplay(transferAmount)} sub={`${transferCount} excluded from totals`} />
          )}
          {pendingCount > 0 && (
            <Stat label="Pending" value={centsToDisplay(pendingAmount)} sub={`${pendingCount} not yet counted`} />
          )}
        </div>
      </div>
    </>
  );
}
