import Link from "next/link";
import { Repeat } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { centsToDisplay } from "@/lib/money";
import type { RecurringRuleRow } from "@/queries/recurring";

const FREQUENCY_LABELS: Record<string, string> = {
  weekly: "weekly",
  biweekly: "every 2 weeks",
  semimonthly: "twice a month",
  monthly: "monthly",
  yearly: "yearly",
};

function describe(rule: RecurringRuleRow): string {
  const parts = [`named “${rule.matchName}”`];
  if (rule.matchMinAmount !== null && rule.matchMaxAmount !== null) {
    parts.push(
      rule.matchMinAmount === rule.matchMaxAmount
        ? centsToDisplay(rule.matchMinAmount)
        : `${centsToDisplay(rule.matchMinAmount)}–${centsToDisplay(rule.matchMaxAmount)}`,
    );
  } else if (rule.matchMinAmount !== null) {
    parts.push(`from ${centsToDisplay(rule.matchMinAmount)}`);
  } else if (rule.matchMaxAmount !== null) {
    parts.push(`up to ${centsToDisplay(rule.matchMaxAmount)}`);
  }
  if (rule.frequency) parts.push(FREQUENCY_LABELS[rule.frequency] ?? rule.frequency);
  if (rule.matchDayOfMonth !== null) parts.push(`on day ${rule.matchDayOfMonth}`);
  return parts.join(" · ");
}

/**
 * Match rules that live on recurring items. Read-only here: the rule belongs to
 * its item, so editing happens in the Recurrings panel, and there is one place
 * a rule can drift from the item it describes.
 */
export function RecurringRulesList({ rules }: { rules: RecurringRuleRow[] }) {
  if (rules.length === 0) return null;

  return (
    <div className="rounded-lg border bg-card">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Recurring rules</h2>
        <p className="text-xs text-muted-foreground">
          {rules.length} rule{rules.length === 1 ? "" : "s"} that link transactions to a recurring item.
          Edit them in Recurrings.
        </p>
      </div>
      <ul className="divide-y">
        {rules.map((rule) => (
          <li key={rule.id}>
            <Link
              href={`/recurrings?item=${rule.id}`}
              className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50"
            >
              <Badge variant="outline" className="shrink-0 gap-1 text-[10px] uppercase tracking-wide">
                <Repeat aria-hidden className="size-3" />
                Recurring
              </Badge>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{rule.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{describe(rule)}</span>
              </span>
              {rule.lifecycle !== "active" && (
                <span className="shrink-0 text-xs capitalize text-muted-foreground">{rule.lifecycle}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
