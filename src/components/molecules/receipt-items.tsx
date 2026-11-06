"use client";

import { useState, useTransition } from "react";
import { ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  createSplitsFromReceipt,
  fetchReceiptItems,
  parseReceiptItems,
  updateReceiptItem,
  type ReceiptItemsResult,
} from "@/actions/receipt-items";
import { centsToDisplay } from "@/lib/money";
import type { CategoryGroup } from "@/queries/categories";

/**
 * Line items read from one receipt. Reading is on demand (it runs the
 * household's own model); fixing a name or category teaches the dictionary so
 * the same product is recognised on later receipts.
 */
export function ReceiptItems({
  receiptId,
  categories,
  onSplitsChanged,
}: {
  receiptId: string;
  categories: CategoryGroup[];
  onSplitsChanged: () => void;
}) {
  const [result, setResult] = useState<ReceiptItemsResult | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function show() {
    setOpen(true);
    setError(null);
    startTransition(async () => {
      const res = await fetchReceiptItems(receiptId);
      if ("data" in res) setResult(res.data);
    });
  }

  function read() {
    setError(null);
    setNote(null);
    startTransition(async () => {
      const res = await parseReceiptItems(receiptId);
      if ("error" in res) setError(res.error);
      else setResult(res.data);
    });
  }

  function save(itemId: string, patch: { productName?: string; categoryId?: string | null }) {
    setError(null);
    startTransition(async () => {
      const res = await updateReceiptItem(itemId, patch);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      const fresh = await fetchReceiptItems(receiptId);
      if ("data" in fresh) setResult(fresh.data);
    });
  }

  function split() {
    setError(null);
    setNote(null);
    startTransition(async () => {
      const res = await createSplitsFromReceipt(receiptId);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setNote(`Split into ${res.data.splits} categories.`);
      onSplitsChanged();
    });
  }

  if (!open) {
    return (
      <div className="px-3.5 pb-2">
        <Button variant="ghost" size="sm" className="h-7 rounded-full px-2 text-xs" onClick={show}>
          <ListChecks className="mr-1 size-3" aria-hidden />
          Items
        </Button>
      </div>
    );
  }

  const options = categories.flatMap((g) => g.categories.filter((c) => !c.isIncome));

  return (
    <div className="space-y-2 px-3.5 pb-3">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" className="h-7 rounded-full text-xs" onClick={read} disabled={pending}>
          {pending ? "Working…" : result?.parsed ? "Read again" : "Read items"}
        </Button>
        {result && result.items.length > 0 && (
          <Button variant="outline" size="sm" className="h-7 rounded-full text-xs" onClick={split} disabled={pending}>
            Split by category
          </Button>
        )}
      </div>

      {result?.items.map((it) => (
        <div key={it.id} className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 text-sm">
          <input
            key={`${it.id}-${it.productName ?? ""}`}
            defaultValue={it.productName ?? it.rawName}
            aria-label={`Product name for ${it.rawName}`}
            className="min-w-0 rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-border focus:border-border"
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== (it.productName ?? it.rawName)) save(it.id, { productName: v });
            }}
          />
          <span className="tabular-nums">{centsToDisplay(it.totalCents)}</span>
          <select
            aria-label={`Category for ${it.rawName}`}
            value={it.categoryId ?? ""}
            onChange={(e) => save(it.id, { categoryId: e.target.value || null })}
            className="col-span-2 rounded border border-border bg-background px-1 py-0.5 text-xs"
          >
            <option value="">No category</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      ))}

      {result && result.items.length > 0 && result.gapCents !== null && result.gapCents !== 0 && (
        <p className="text-xs text-muted-foreground">
          Items add up to {centsToDisplay(result.itemsTotalCents)};{" "}
          {result.gapCents > 0
            ? `${centsToDisplay(result.gapCents)} more is tax or fees (spread across categories when you split).`
            : `${centsToDisplay(-result.gapCents)} less than the lines. Check for a missed discount.`}
        </p>
      )}
      {result && !result.parsed && !pending && (
        <p className="text-xs text-muted-foreground">Not read yet. Reading uses your local model.</p>
      )}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
