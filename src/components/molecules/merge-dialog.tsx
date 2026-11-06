"use client";

import { useState, useTransition } from "react";
import { Merge } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface MergeOption {
  id: string;
  label: string;
}

interface MergeDialogProps {
  /** Accessible name of the opening button, e.g. "Merge Gas into another category". */
  triggerLabel: string;
  title: string;
  description: string;
  options: MergeOption[];
  disabled?: boolean;
  onMerge: (targetId: string) => Promise<{ success: true } | { error: string }>;
  onError: (message: string) => void;
  onMerged: () => void;
}

export function MergeDialog({
  triggerLabel,
  title,
  description,
  options,
  disabled,
  onMerge,
  onError,
  onMerged,
}: MergeDialogProps) {
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [pending, startTransition] = useTransition();
  const targetLabel = options.find((option) => option.id === targetId)?.label;

  function confirm() {
    startTransition(async () => {
      const result = await onMerge(targetId);
      if ("error" in result) {
        onError(result.error);
        setOpen(false);
        return;
      }
      setOpen(false);
      setTargetId("");
      onMerged();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={triggerLabel}
        disabled={disabled || options.length === 0}
        onClick={() => setOpen(true)}
      >
        <Merge className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <Select
            value={targetId}
            onValueChange={(value) => {
              if (value !== null) setTargetId(value);
            }}
          >
            <SelectTrigger className="w-full" aria-label="Merge into">
              <SelectValue placeholder="Merge into...">{targetLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={pending || !targetId} onClick={confirm}>
              {pending ? "Merging..." : "Merge"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
