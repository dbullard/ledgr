"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Building2,
  ArrowLeftRight,
  TrendingUp,
  Wallet,
  BarChart3,
  Receipt,
  Upload,
  Settings,
  Tag,
  Shapes,
} from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { AmountDisplay } from "@/components/atoms/amount-display";
import { formatDateShort } from "@/lib/date-utils";
import type { SearchResults } from "@/app/api/search/route";

const PAGES = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/accounts", label: "Accounts", icon: Building2 },
  { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { href: "/rules", label: "Rules", icon: Tag },
  { href: "/categories", label: "Categories", icon: Shapes },
  { href: "/investments", label: "Investments", icon: TrendingUp },
  { href: "/budgets", label: "Budgets", icon: Wallet },
  { href: "/recurrings", label: "Recurrings", icon: Receipt },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/import", label: "Import", icon: Upload },
  { href: "/settings", label: "Settings", icon: Settings },
];

const EMPTY: SearchResults = { transactions: [], accounts: [] };

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(EMPTY);
  const [searching, setSearching] = useState(false);

  // Debounced so typing does not fire a query per keystroke. The ref holds the
  // latest request so a slow earlier response cannot overwrite a newer one.
  const latestRequest = useRef(0);

  useEffect(() => {
    if (!open) return;

    const trimmed = query.trim();
    // Nothing to fetch yet. The short-query and closed states are *derived*
    // below rather than written back here — clearing state from inside an
    // effect is what triggers cascading renders.
    if (trimmed.length < 2) return;

    const requestId = ++latestRequest.current;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`);
        const data: SearchResults = await res.json();
        if (requestId === latestRequest.current) setResults(data);
      } catch {
        // A failed lookup should leave the palette usable for navigation
        // rather than tearing it down.
        if (requestId === latestRequest.current) setResults(EMPTY);
      } finally {
        if (requestId === latestRequest.current) setSearching(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [query, open]);

  // Reset on close in the handler rather than an effect, so the palette never
  // opens showing a stale search and no state is written from inside an effect.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setQuery("");
        setResults(EMPTY);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const go = useCallback(
    (href: string) => {
      handleOpenChange(false);
      router.push(href);
    },
    [handleOpenChange, router],
  );

  const needle = query.trim().toLowerCase();

  // Derived, not stored: a query too short to search shows nothing regardless
  // of what the last completed search returned.
  const visible = needle.length < 2 ? EMPTY : results;
  const hasResults = visible.transactions.length > 0 || visible.accounts.length > 0;
  const matchingPages = needle
    ? PAGES.filter((p) => p.label.toLowerCase().includes(needle))
    : PAGES;

  // Only pages that match the query are offered. Falling back to *every* page
  // when nothing matched put Dashboard first, so pressing Enter on a search that
  // had not returned yet (or matched nothing) silently navigated to the
  // Dashboard instead of doing nothing.
  const pages = matchingPages;

  // The highlighted row is controlled rather than left to cmdk. With cmdk's own
  // filtering off it keeps the previously highlighted row when the results
  // change, so a Dashboard highlighted before the search returned stayed
  // highlighted underneath the new Transactions group. Results are shown in
  // order, so the first one is the default; arrow keys and hover override it
  // until the list changes.
  const firstValue = visible.transactions[0]
    ? `txn-${visible.transactions[0].id}`
    : visible.accounts[0]
      ? `acct-${visible.accounts[0].id}`
      : (pages[0]?.label ?? "");
  const listKey = [
    needle,
    visible.transactions.map((t) => t.id).join(),
    visible.accounts.map((a) => a.id).join(),
  ].join("|");
  const [pick, setPick] = useState<{ key: string; value: string } | null>(null);
  const selected = pick && pick.key === listKey ? pick.value : firstValue;

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Search"
      description="Search transactions and accounts, or jump to a page."
    >
      {/*
        cmdk's own filtering is off: the transaction and account rows are
        already filtered server-side for this exact query, and letting cmdk
        filter them again by visible label would drop rows that matched on a
        field the label does not show. Pages are filtered explicitly below
        instead, so the behaviour is the same for every group.
      */}
      <Command
        shouldFilter={false}
        value={selected}
        onValueChange={(value) => setPick({ key: listKey, value })}
      >
        <CommandInput
          placeholder="Search transactions and accounts, or jump to a page…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
        <CommandEmpty>
          {searching ? "Searching…" : query.trim().length < 2 ? "Type to search." : "No matches."}
        </CommandEmpty>

        {visible.transactions.length > 0 && (
          <CommandGroup heading="Transactions">
            {visible.transactions.map((t) => (
              <CommandItem
                key={t.id}
                value={`txn-${t.id}`}
                onSelect={() => go(`/transactions?txn=${t.id}`)}
              >
                <span className="flex-1 truncate">{t.name}</span>
                <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                  {formatDateShort(t.date)}
                  {t.categoryName ? ` · ${t.categoryName}` : ""}
                </span>
                <AmountDisplay
                  amount={t.normalizedAmount}
                  currency={t.currency}
                  className="ml-3 shrink-0"
                />
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {visible.accounts.length > 0 && (
          <CommandGroup heading="Accounts">
            {visible.accounts.map((a) => (
              <CommandItem key={a.id} value={`acct-${a.id}`} onSelect={() => go("/accounts")}>
                <Building2 />
                <span className="truncate">{a.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

          {pages.length > 0 && (
          <CommandGroup heading={hasResults ? "Go to" : "Pages"}>
            {pages.map((page) => (
              <CommandItem key={page.href} value={page.label} onSelect={() => go(page.href)}>
                <page.icon />
                <span>{page.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
