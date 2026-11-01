"use client";

import Link from "next/link";
import { CategoryIconTile } from "@/components/atoms/category-icon";
import { CategoryChip } from "@/components/molecules/category-chip";
import { categoryTone } from "@/lib/category-tone";
import { centsToDisplay } from "@/lib/money";
import type { BillRow } from "@/queries/recurring";

interface UpcomingBillsWidgetProps {
  data: BillRow[];
}

const FREQUENCY_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  semimonthly: "2x/mo",
  monthly: "Monthly",
  yearly: "Yearly",
};

function formatDate(date: string | null) {
  if (!date) return "—";
  return new Date(date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function UpcomingBillsWidget({ data }: UpcomingBillsWidgetProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No upcoming bills
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 space-y-0.5">
        {data.map((bill) => (
          <div key={bill.id} className="flex items-center gap-3 rounded-lg px-1 py-1.5">
            <span className="w-12 shrink-0 text-xs font-medium text-primary tabular-nums">
              {formatDate(bill.nextDate)}
            </span>
            <CategoryIconTile
              name={bill.categoryIcon}
              iconSize={14}
              className="size-8 rounded-xl"
              style={{
                color: categoryTone(bill.categoryName),
                backgroundColor: `color-mix(in oklab, ${categoryTone(bill.categoryName)} 16%, transparent)`,
              }}
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{bill.name}</p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {bill.frequency && <span>{FREQUENCY_LABELS[bill.frequency] ?? bill.frequency}</span>}
                <CategoryChip name={bill.categoryName} />
              </div>
            </div>
            <span className="tabular-nums text-sm font-medium shrink-0">
              {bill.averageAmount !== null ? centsToDisplay(bill.averageAmount) : "—"}
            </span>
          </div>
        ))}
      </div>
      <Link
        href="/bills"
        className="text-xs text-primary hover:underline mt-2 text-center"
      >
        View all bills
      </Link>
    </div>
  );
}
