"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { bulkMarkReviewed } from "@/actions/transactions";
import { AmountDisplay } from "@/components/atoms/amount-display";
import { CategoryChip } from "@/components/molecules/category-chip";
import { WidgetPlaceholder } from "@/components/molecules/widget-placeholder";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { TransactionRow } from "@/queries/transactions";

interface ReviewQueueWidgetProps {
  rows: TransactionRow[];
  /** Everything still awaiting review, not just the rows shown. */
  total: number;
}

function formatDate(date: string) {
  return new Date(date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function ReviewQueueWidget({ rows, total }: ReviewQueueWidgetProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (rows.length === 0) {
    return (
      <WidgetPlaceholder
        title="All caught up"
        description="Every transaction has been reviewed."
        actions={[{ label: "View transactions", href: "/transactions" }]}
      />
    );
  }

  // Nothing ticked means "the lot": the common case is a quick skim, then one click.
  const targets = selected.size > 0 ? rows.filter((r) => selected.has(r.id)) : rows;

  function toggle(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function markReviewed() {
    setError(null);
    startTransition(async () => {
      const result = await bulkMarkReviewed(targets.map((r) => r.id), true);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSelected(new Set());
      router.refresh();
    });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-h-0 space-y-0.5 overflow-y-auto">
        {rows.map((tx) => (
          <label
            key={tx.id}
            className="flex cursor-pointer items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-accent/50"
          >
            <Checkbox
              checked={selected.has(tx.id)}
              onCheckedChange={(checked) => toggle(tx.id, checked === true)}
              aria-label={`Select ${tx.merchantName ?? tx.name}`}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{tx.merchantName ?? tx.name}</p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="shrink-0">{formatDate(tx.date)}</span>
                {!tx.isTransfer && <CategoryChip name={tx.categoryName} />}
              </div>
            </div>
            <AmountDisplay amount={tx.normalizedAmount} currency={tx.currency} />
          </label>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2">
        <span className="text-xs text-muted-foreground">
          {error ?? `${rows.length} of ${total}`}
        </span>
        <Button size="sm" onClick={markReviewed} disabled={isPending}>
          <Check aria-hidden />
          {isPending ? "Saving…" : `Mark ${targets.length} as reviewed`}
        </Button>
      </div>
    </div>
  );
}
