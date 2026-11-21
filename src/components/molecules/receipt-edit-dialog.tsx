"use client";

import { useEffect, useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fetchReceiptForEdit, saveReceiptEdits } from "@/actions/receipt-edit";
import type { ReceiptEditData, ReceiptEditInput } from "@/lib/receipts/edit";
import { centsToDisplay, centsToInputDisplay, parseToCents } from "@/lib/money";
import type { CategoryGroup } from "@/queries/categories";

interface Row {
  key: string;
  id?: string;
  rawName: string;
  productName: string;
  categoryId: string;
  quantity: string;
  price: string;
}

let nextKey = 0;
const newKey = () => `row-${nextKey++}`;

function quantityToMilli(text: string): number | null {
  const n = Number(text.trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
}

function toRows(data: ReceiptEditData): Row[] {
  return data.items.map((it) => ({
    key: newKey(),
    id: it.id,
    rawName: it.rawName,
    productName: it.productName ?? "",
    categoryId: it.categoryId ?? "",
    quantity: String(it.quantityMilli / 1000),
    price: centsToInputDisplay(it.totalCents),
  }));
}

/**
 * Fixes what Ledgr read from a receipt: total, date, merchant and every line,
 * in one save. Nothing is written until Save; Cancel throws the edits away.
 */
export function ReceiptEditDialog({
  receiptId,
  categories,
  open,
  onOpenChange,
  onSaved,
}: {
  receiptId: string;
  categories: CategoryGroup[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [total, setTotal] = useState("");
  const [date, setDate] = useState("");
  const [merchant, setMerchant] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  // What the lines are compared with when the total field is left empty: the transaction's amount.
  const [fallbackExpected, setFallbackExpected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetchReceiptForEdit(receiptId).then((res) => {
      if (!live) return;
      if ("error" in res) {
        setError(res.error);
        return;
      }
      const d = res.data;
      setTotal(d.totalCents === null ? "" : centsToInputDisplay(d.totalCents));
      setDate(d.date ?? "");
      setMerchant(d.merchant ?? "");
      setRows(toRows(d));
      setFallbackExpected(d.totalCents === null && d.gapCents !== null ? d.itemsTotalCents + d.gapCents : null);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [open, receiptId]);

  // Closing resets the form, so reopening starts from what is saved.
  function change(next: boolean) {
    if (!next) {
      setLoaded(false);
      setError(null);
    }
    onOpenChange(next);
  }

  const options = categories.flatMap((g) => g.categories.filter((c) => !c.isIncome));
  const totalCents = parseToCents(total);
  const itemsCents = rows.reduce((s, r) => s + (parseToCents(r.price) ?? 0), 0);
  const expected = totalCents ?? fallbackExpected;
  const gap = expected === null || rows.length === 0 ? null : expected - itemsCents;

  function patch(key: string, change: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...change } : r)));
  }

  function save() {
    setError(null);
    if (total.trim() !== "" && totalCents === null) return setError("The total isn't a valid amount");
    const items: ReceiptEditInput["items"] = [];
    for (const [i, r] of rows.entries()) {
      const price = parseToCents(r.price);
      const qty = quantityToMilli(r.quantity);
      if (price === null) return setError(`Line ${i + 1}: enter a price`);
      if (qty === null) return setError(`Line ${i + 1}: quantity must be more than zero`);
      items.push({
        ...(r.id ? { id: r.id } : {}),
        rawName: r.rawName,
        productName: r.productName.trim() === "" ? null : r.productName,
        categoryId: r.categoryId === "" ? null : r.categoryId,
        quantityMilli: qty,
        totalCents: price,
      });
    }
    startTransition(async () => {
      const res = await saveReceiptEdits(receiptId, {
        totalCents: total.trim() === "" ? null : totalCents,
        date: date.trim() === "" ? null : date.trim(),
        merchant: merchant.trim() === "" ? null : merchant,
        items,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      onSaved();
      change(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit receipt</DialogTitle>
          <DialogDescription>Fix what was read from the receipt. Nothing changes until you save.</DialogDescription>
        </DialogHeader>

        {!loaded && !error && <p className="text-sm text-muted-foreground">Loading…</p>}

        {loaded && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <label className="space-y-1 text-xs text-muted-foreground">
                Total
                <Input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="0.00" aria-label="Total" />
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                Date
                <Input value={date} onChange={(e) => setDate(e.target.value)} placeholder="YYYY-MM-DD" aria-label="Date" />
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                Merchant
                <Input value={merchant} onChange={(e) => setMerchant(e.target.value)} aria-label="Merchant" />
              </label>
            </div>

            <div className="space-y-3">
              {rows.map((r, i) => (
                <div key={r.key} className="grid grid-cols-[1fr_4rem_6rem_auto] items-center gap-2 rounded-lg border border-border p-2">
                  <Input value={r.rawName} onChange={(e) => patch(r.key, { rawName: e.target.value })} aria-label={`Printed name, line ${i + 1}`} />
                  <Input inputMode="decimal" value={r.quantity} onChange={(e) => patch(r.key, { quantity: e.target.value })} aria-label={`Quantity, line ${i + 1}`} />
                  <Input inputMode="decimal" value={r.price} onChange={(e) => patch(r.key, { price: e.target.value })} aria-label={`Price, line ${i + 1}`} />
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} aria-label={`Delete line ${i + 1}`}>
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                  <Input
                    value={r.productName}
                    onChange={(e) => patch(r.key, { productName: e.target.value })}
                    placeholder="Product name"
                    aria-label={`Product name, line ${i + 1}`}
                    className="col-span-2"
                  />
                  <select
                    value={r.categoryId}
                    onChange={(e) => patch(r.key, { categoryId: e.target.value })}
                    aria-label={`Category, line ${i + 1}`}
                    className="col-span-2 rounded border border-border bg-background px-1 py-1.5 text-xs"
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRows((rs) => [...rs, { key: newKey(), rawName: "", productName: "", categoryId: "", quantity: "1", price: "" }])}
              >
                <Plus className="mr-1 size-3" aria-hidden />
                Add line
              </Button>
            </div>

            {rows.length > 0 && (
              <p className="text-xs text-muted-foreground" aria-live="polite">
                Lines add up to {centsToDisplay(itemsCents)}
                {gap !== null && gap !== 0 && (
                  <>
                    {"; "}
                    {gap > 0 ? `${centsToDisplay(gap)} less than the total (tax or fees?)` : `${centsToDisplay(-gap)} more than the total`}
                  </>
                )}
                .
              </p>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => change(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={!loaded || pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
