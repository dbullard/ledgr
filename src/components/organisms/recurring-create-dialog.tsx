"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createRecurringTransaction } from "@/actions/recurring";
import { todayDateString } from "@/lib/date-utils";
import type { CategoryGroup } from "@/queries/categories";

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

export function RecurringCreateDialog({ categoryGroups }: { categoryGroups: CategoryGroup[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("monthly");
  const [nextDate, setNextDate] = useState(() => todayDateString());
  const [categoryId, setCategoryId] = useState(NO_CATEGORY);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    const dollars = parseFloat(amount);
    if (!name.trim()) return setError("Give it a name.");
    if (!Number.isFinite(dollars) || dollars < 0) return setError("Enter the amount as a number.");

    startTransition(async () => {
      const result = await createRecurringTransaction({
        name,
        amount: Math.round(dollars * 100),
        frequency,
        nextDate,
        categoryId: categoryId === NO_CATEGORY ? null : categoryId,
        accountId: null,
      });
      if ("error" in result) return setError(result.error);
      setOpen(false);
      setName("");
      setAmount("");
      router.replace(`/recurrings?item=${result.recurringId}`);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" aria-label="Add recurring" />}>
        <Plus aria-hidden /> Add
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a recurring item</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {error && (
            <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="new-rec-name">Name</Label>
            <Input id="new-rec-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-rec-amount">Amount ($)</Label>
              <Input id="new-rec-amount" type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-rec-next">Next payment</Label>
              <Input id="new-rec-next" type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-rec-frequency">Frequency</Label>
              <Select value={frequency} onValueChange={(v) => v !== null && setFrequency(v as Frequency)}>
                <SelectTrigger id="new-rec-frequency"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FREQUENCIES.map((f) => (
                    <SelectItem key={f} value={f}>{FREQUENCY_LABELS[f]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-rec-category">Category</Label>
              <Select value={categoryId} onValueChange={(v) => v !== null && setCategoryId(v)}>
                <SelectTrigger id="new-rec-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CATEGORY}>Uncategorized</SelectItem>
                  {categoryGroups.flatMap((g) => g.categories).map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending}>Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
