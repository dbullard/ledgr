import { AmountDisplay } from "@/components/atoms/amount-display";
import { CategoryChip } from "@/components/molecules/category-chip";
import { cn } from "@/lib/utils";
import type { RecurringRow } from "@/queries/recurring";

const FREQUENCY_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  semimonthly: "Twice a month",
  monthly: "Monthly",
  yearly: "Annually",
};

function ordinal(n: number): string {
  const rem = n % 100;
  if (rem >= 11 && rem <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10 > 3 ? 0 : n % 10]}`;
}

/** "Nov 5th" — the due date as Copilot writes it. */
export function formatDueDate(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  const month = new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return `${month} ${ordinal(d)}`;
}

interface RecurringItemRowProps {
  item: RecurringRow;
  selected: boolean;
  onSelect: () => void;
}

export function RecurringItemRow({ item, selected, onSelect }: RecurringItemRowProps) {
  const overdue = item.lifecycle === "active" && item.isActive && item.status === "overdue";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Open ${item.name}`}
      aria-pressed={selected}
      className={cn(
        "grid w-full grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-accent/50",
        "focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
        selected && "bg-accent ring-1 ring-ring",
      )}
    >
      <span className={cn("text-xs font-medium tabular-nums", overdue ? "text-destructive" : "text-primary")}>
        {overdue ? "Overdue" : item.nextDate ? formatDueDate(item.nextDate) : "—"}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{item.name}</span>
        <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          {item.frequency && <span>{FREQUENCY_LABELS[item.frequency] ?? item.frequency}</span>}
          <CategoryChip name={item.categoryName} icon={item.categoryIcon} />
        </span>
      </span>
      {item.averageAmount !== null && <AmountDisplay amount={item.averageAmount} absolute />}
    </button>
  );
}
