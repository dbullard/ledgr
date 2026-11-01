"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { AmountDisplay } from "@/components/atoms/amount-display";
import { CategoryChip } from "@/components/molecules/category-chip";
import { formatDueDate } from "@/components/molecules/recurring-item-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  fetchLinkableTransactions,
  linkTransactionToRecurring,
  setRecurringStatus,
  unlinkTransactionFromRecurring,
  updateRecurringRules,
  updateRecurringTransaction,
} from "@/actions/recurring";
import type { RecurringRow } from "@/queries/recurring";
import type { CategoryGroup } from "@/queries/categories";
import type { TransactionRow } from "@/queries/transactions";

const FREQUENCIES = ["weekly", "biweekly", "semimonthly", "monthly", "yearly"] as const;
type Frequency = (typeof FREQUENCIES)[number];
const FREQUENCY_LABELS: Record<Frequency, string> = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  semimonthly: "Twice a month",
  monthly: "Monthly",
  yearly: "Annually",
};
const NO_CATEGORY = "__none__";
const ANY_DAY = "any";

const toDollars = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));
const toCents = (dollars: string) => (dollars.trim() === "" ? null : Math.round(parseFloat(dollars) * 100));

interface RecurringDetailPanelProps {
  item: RecurringRow;
  transactions: TransactionRow[];
  categoryGroups: CategoryGroup[];
  onClose: () => void;
}

/** Keyed by item id by the parent, so the form re-seeds when another item opens. */
export function RecurringDetailPanel({ item, transactions, categoryGroups, onClose }: RecurringDetailPanelProps) {
  const router = useRouter();
  const categories = categoryGroups.flatMap((g) => g.categories);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [categoryId, setCategoryId] = useState(item.categoryId ?? NO_CATEGORY);
  const [displayName, setDisplayName] = useState(item.name);
  const [matchName, setMatchName] = useState(item.matchName ?? "");
  const [minAmount, setMinAmount] = useState(toDollars(item.matchMinAmount));
  const [maxAmount, setMaxAmount] = useState(toDollars(item.matchMaxAmount));
  const [day, setDay] = useState(item.matchDayOfMonth ? String(item.matchDayOfMonth) : ANY_DAY);
  const [frequency, setFrequency] = useState<Frequency>((item.frequency as Frequency) ?? "monthly");

  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<TransactionRow[]>([]);

  function run(work: () => Promise<{ success: true } | { error: string } | unknown>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = (await work()) as { error?: string };
      if (result && typeof result === "object" && "error" in result && result.error) {
        setError(result.error);
        return;
      }
      after?.();
      router.refresh();
    });
  }

  function saveCategory(next: string) {
    setCategoryId(next);
    run(() =>
      updateRecurringTransaction({
        id: item.id,
        name: item.name,
        categoryId: next === NO_CATEGORY ? null : next,
        averageAmount: item.averageAmount ?? 0,
        frequency: (item.frequency as Frequency) ?? "monthly",
        isActive: item.isActive,
      }),
    );
  }

  function saveRules() {
    const min = toCents(minAmount);
    const max = toCents(maxAmount);
    run(() =>
      updateRecurringRules({
        id: item.id,
        name: displayName,
        matchName,
        matchMinAmount: min,
        matchMaxAmount: max,
        matchDayOfMonth: day === ANY_DAY ? null : Number(day),
        frequency,
      }),
    );
  }

  function loadCandidates(query: string) {
    startTransition(async () => {
      const result = await fetchLinkableTransactions(query);
      if ("error" in result) setError(result.error);
      else setCandidates(result.rows);
    });
  }

  const lastAccount = transactions[0]?.accountName ?? item.accountName;
  const archived = item.lifecycle === "archived";
  const paused = item.lifecycle === "paused" || (item.lifecycle === "active" && !item.isActive);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <CategoryChip name={item.categoryName} icon={item.categoryIcon} />
          <h3 className="mt-2 truncate text-lg font-semibold">{item.name}</h3>
        </div>
        <div className="text-right">
          {item.averageAmount !== null && <AmountDisplay amount={item.averageAmount} absolute className="text-lg font-semibold" />}
          {item.nextDate && (
            <p className="text-xs text-muted-foreground">
              Next payment around <span className="text-foreground">{formatDueDate(item.nextDate)}</span>
            </p>
          )}
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="rec-category">Category</Label>
        <Select value={categoryId} onValueChange={(v) => v !== null && saveCategory(v)} disabled={pending}>
          <SelectTrigger id="rec-category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_CATEGORY}>Uncategorized</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <section className="space-y-3">
        <h4 className="text-sm font-semibold">Rules</h4>
        <p className="text-xs text-muted-foreground">
          Transactions that fit these rules are added to this item and move its next payment date.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="rec-display-name">Name</Label>
          <Input id="rec-display-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rec-name">Matches transactions named</Label>
          <Input
            id="rec-name"
            value={matchName}
            placeholder="Part of the name your bank shows"
            onChange={(e) => setMatchName(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="rec-min">From ($)</Label>
            <Input id="rec-min" type="number" step="0.01" min="0" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rec-max">To ($)</Label>
            <Input id="rec-max" type="number" step="0.01" min="0" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="rec-frequency">Every</Label>
            <Select value={frequency} onValueChange={(v) => v !== null && setFrequency(v as Frequency)}>
              <SelectTrigger id="rec-frequency"><SelectValue /></SelectTrigger>
              <SelectContent>
                {FREQUENCIES.map((f) => (
                  <SelectItem key={f} value={f}>{FREQUENCY_LABELS[f]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rec-day">On</Label>
            <Select value={day} onValueChange={(v) => v !== null && setDay(v)}>
              <SelectTrigger id="rec-day"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_DAY}>Any day of the month</SelectItem>
                {Array.from({ length: 31 }, (_, i) => (
                  <SelectItem key={i + 1} value={String(i + 1)}>Day {i + 1}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button size="sm" onClick={saveRules} disabled={pending || !matchName.trim() || !displayName.trim()}>
          Save rules
        </Button>
      </section>

      {lastAccount && (
        <section>
          <h4 className="text-sm font-semibold">Last account used</h4>
          <p className="mt-1 text-sm text-muted-foreground">{lastAccount}</p>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">Transactions</h4>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const next = !adding;
              setAdding(next);
              if (next) loadCandidates("");
            }}
          >
            {adding ? "Done" : "Add"}
          </Button>
        </div>

        {adding && (
          <div className="space-y-2 rounded-lg border p-2">
            <Input
              placeholder="Search transactions…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadCandidates(search)}
              aria-label="Search transactions to add"
            />
            <ul className="max-h-48 space-y-0.5 overflow-y-auto">
              {candidates.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 rounded px-1 py-1 text-left text-sm hover:bg-accent/50"
                    onClick={() =>
                      run(() => linkTransactionToRecurring(item.id, t.id), () =>
                        setCandidates((c) => c.filter((x) => x.id !== t.id)),
                      )
                    }
                  >
                    <span className="min-w-0 truncate">{t.merchantName ?? t.name}</span>
                    <AmountDisplay amount={t.normalizedAmount} currency={t.currency} />
                  </button>
                </li>
              ))}
              {candidates.length === 0 && <li className="px-1 py-1 text-xs text-muted-foreground">Nothing to add.</li>}
            </ul>
          </div>
        )}

        <ul className="space-y-0.5">
          {transactions.map((t) => (
            <li key={t.id} className="flex items-center gap-2 text-sm">
              <span className="w-14 shrink-0 text-xs text-muted-foreground tabular-nums">{formatDueDate(t.date)}</span>
              <span className="min-w-0 flex-1 truncate">{t.merchantName ?? t.name}</span>
              <AmountDisplay amount={t.normalizedAmount} currency={t.currency} />
              <button
                type="button"
                aria-label={`Remove ${t.merchantName ?? t.name} from ${item.name}`}
                className="rounded p-1 text-muted-foreground hover:text-foreground"
                disabled={pending}
                onClick={() => run(() => unlinkTransactionFromRecurring(t.id))}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
          {transactions.length === 0 && <li className="text-xs text-muted-foreground">No transactions linked yet.</li>}
        </ul>
      </section>

      <div className="flex flex-wrap gap-2 border-t pt-4">
        {!archived && (
          <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => setRecurringStatus(item.id, paused ? "active" : "paused"))}>
            {paused ? "Resume" : "Pause"}
          </Button>
        )}
        <Button
          variant={archived ? "outline" : "ghost"}
          size="sm"
          className={archived ? undefined : "text-destructive hover:text-destructive"}
          disabled={pending}
          onClick={() => run(() => setRecurringStatus(item.id, archived ? "active" : "archived"), archived ? undefined : onClose)}
        >
          {archived ? "Restore" : "Archive"}
        </Button>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
