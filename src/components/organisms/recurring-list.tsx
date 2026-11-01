"use client";

import { useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { RecurringItemRow } from "@/components/molecules/recurring-item-row";
import { RecurringDetailPanel } from "@/components/organisms/recurring-detail-panel";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { RecurringGroups, RecurringRow } from "@/queries/recurring";
import type { CategoryGroup } from "@/queries/categories";
import type { TransactionRow } from "@/queries/transactions";

export interface SelectedRecurring {
  item: RecurringRow;
  transactions: TransactionRow[];
}

interface RecurringListProps {
  groups: RecurringGroups;
  categoryGroups: CategoryGroup[];
  selected: SelectedRecurring | null;
}

/** Below `lg` the panel is a sheet; at `lg` and up it sits beside the list. */
function useBelowLg(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia("(max-width: 1023px)");
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.innerWidth < 1024,
    () => false,
  );
}

export function RecurringList({ groups, categoryGroups, selected }: RecurringListProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isMobile = useBelowLg();

  function select(id: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set("item", id);
    else params.delete("item");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  // Overdue items lead "This month": they are what needs attention first.
  const sections: { title: string; rows: RecurringRow[] }[] = [
    { title: "This month", rows: [...groups.overdue, ...groups.thisMonth] },
    { title: "In the future", rows: groups.future },
    { title: "Paused", rows: groups.paused },
    { title: "Archived", rows: groups.archived },
  ].filter((s) => s.rows.length > 0);

  const panel = selected && (
    <RecurringDetailPanel
      key={selected.item.id}
      item={selected.item}
      transactions={selected.transactions}
      categoryGroups={categoryGroups}
      onClose={() => select(null)}
    />
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-6">
        {sections.map((section) => {
          const rows = (
            <div>
              {section.rows.map((item) => (
                <RecurringItemRow
                  key={item.id}
                  item={item}
                  selected={selected?.item.id === item.id}
                  onSelect={() => select(item.id)}
                />
              ))}
            </div>
          );
          // Archived can run long (detection archives what you dismiss), so it
          // starts folded, unless the open item lives in it.
          if (section.title === "Archived") {
            const holdsSelected = section.rows.some((r) => r.id === selected?.item.id);
            return (
              <details key={section.title} open={holdsSelected || undefined}>
                <summary className="mb-1 cursor-pointer px-2">
                  <h2 className="inline text-sm font-semibold">Archived</h2>
                  <span className="ml-1.5 text-xs text-muted-foreground">({section.rows.length})</span>
                </summary>
                {rows}
              </details>
            );
          }
          return (
            <section key={section.title}>
              <h2 className="mb-1 px-2 text-sm font-semibold">{section.title}</h2>
              {rows}
            </section>
          );
        })}
      </div>

      {selected && !isMobile && (
        <aside>
          <div className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl bg-card p-4 ring-1 ring-foreground/10">
            {panel}
          </div>
        </aside>
      )}
      {selected && isMobile && (
        <Sheet open onOpenChange={(open) => !open && select(null)}>
          <SheetContent className="flex w-full flex-col overflow-y-auto sm:w-[440px]">
            <SheetHeader>
              <SheetTitle className="sr-only">{selected.item.name}</SheetTitle>
            </SheetHeader>
            <div className="px-4 pb-4">{panel}</div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
