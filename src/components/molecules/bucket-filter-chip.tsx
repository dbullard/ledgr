"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Stays in view while the list scrolls, so narrowing to a chart bucket can be undone from anywhere in it. */
export function BucketFilterChip({ label }: { label: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function showAll() {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("bucket");
    const qs = next.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  }

  return (
    <div className="sticky top-0 z-20 -mx-1 flex items-center justify-between gap-2 border-b border-border/60 bg-background/95 px-1 py-2 backdrop-blur">
      <span className="text-sm text-muted-foreground">
        Showing <span className="font-medium text-foreground">{label}</span> only
      </span>
      <Button size="sm" variant="secondary" onClick={showAll} disabled={pending}>
        <X className="size-3.5" />
        Show all transactions
      </Button>
    </div>
  );
}
