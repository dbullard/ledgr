"use client";

import Link from "next/link";
import { AmountDisplay } from "@/components/atoms/amount-display";
import { CategoryIconTile } from "@/components/atoms/category-icon";
import { CategoryChip } from "@/components/molecules/category-chip";
import { WidgetPlaceholder } from "@/components/molecules/widget-placeholder";
import { categoryTone } from "@/lib/category-tone";
import type { TransactionRow } from "@/queries/transactions";

interface RecentTransactionsWidgetProps {
  data: TransactionRow[];
}

function formatDate(date: string) {
  return new Date(date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function RecentTransactionsWidget({ data }: RecentTransactionsWidgetProps) {
  if (data.length === 0) {
    return (
      <WidgetPlaceholder
        title="No transactions yet"
        description="Connect a bank or import a CSV and activity will show up here."
        actions={[
          { label: "Connect a bank", href: "/accounts", primary: true },
          { label: "Import CSV", href: "/import" },
        ]}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 space-y-0.5">
        {data.map((tx) => (
          <div key={tx.id} className="flex items-center gap-3 rounded-lg px-1 py-1.5">
            <CategoryIconTile
              name={tx.categoryIcon}
              iconSize={14}
              className="size-8 rounded-xl"
              style={{
                color: categoryTone(tx.categoryName),
                backgroundColor: `color-mix(in oklab, ${categoryTone(tx.categoryName)} 16%, transparent)`,
              }}
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{tx.merchantName ?? tx.name}</p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="shrink-0">{formatDate(tx.date)}</span>
                {!tx.isTransfer && <CategoryChip name={tx.categoryName} />}
              </div>
            </div>
            <AmountDisplay amount={tx.normalizedAmount} currency={tx.currency} />
          </div>
        ))}
      </div>
      <Link
        href="/transactions"
        className="text-xs text-primary hover:underline text-center pt-2 mt-auto"
      >
        View all transactions
      </Link>
    </div>
  );
}
