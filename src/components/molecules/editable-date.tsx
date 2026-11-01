"use client";

import { useState, useTransition } from "react";
import { Check, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateShort } from "@/lib/date-utils";

interface EditableDateProps {
  /** YYYY-MM-DD */
  value: string;
  onSave: (value: string) => Promise<{ success: true } | { error: string }>;
}

/**
 * Click-to-edit date with the browser's own date picker. Saving is explicit
 * (tick or Enter) rather than on blur: a native date field fires change events
 * while a year is half-typed, and saving "0002-05-01" on the way to "2026" would
 * move a transaction to the first century.
 */
export function EditableDate({ value, onSave }: EditableDateProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function start() {
    setDraft(value);
    setError(null);
    setIsEditing(true);
  }

  function save() {
    if (!draft || draft === value) {
      setIsEditing(false);
      return;
    }
    startTransition(async () => {
      const result = await onSave(draft);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setIsEditing(false);
    });
  }

  if (!isEditing) {
    return (
      <button
        type="button"
        onClick={start}
        aria-label="Edit date"
        className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 -mx-1 text-sm hover:bg-muted/50"
      >
        <span>{formatDateShort(value)}</span>
        <Pencil aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <Input
          autoFocus
          type="date"
          value={draft}
          min="1990-01-01"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
            if (e.key === "Escape") setIsEditing(false);
          }}
          disabled={isPending}
          aria-label="Transaction date"
          className="h-8 w-40 px-2 text-sm"
        />
        <Button size="icon" className="size-8" onClick={save} disabled={isPending} aria-label="Save date">
          <Check />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          onClick={() => setIsEditing(false)}
          disabled={isPending}
          aria-label="Cancel"
        >
          <X />
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
