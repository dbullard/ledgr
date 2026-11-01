"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { makeTransactionRecurring } from "@/actions/recurring";

/** Turns a transaction into a recurring item, then points at it. */
export function MakeRecurringButton({ transactionId }: { transactionId: string }) {
  const [recurringId, setRecurringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (recurringId) {
    return (
      <Link href={`/recurrings?item=${recurringId}`} className="text-xs text-primary hover:underline">
        Added — view in Recurrings
      </Link>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-7 rounded-full text-xs"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await makeTransactionRecurring(transactionId);
            if ("error" in result) setError(result.error);
            else setRecurringId(result.recurringId);
          });
        }}
      >
        <Repeat aria-hidden className="size-3" />
        Make recurring
      </Button>
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
