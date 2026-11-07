"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { FileText, Loader2, Paperclip, Trash2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { centsToDisplay } from "@/lib/money";
import { ReceiptItems } from "@/components/molecules/receipt-items";
import type { CategoryGroup } from "@/queries/categories";
import { DetailGroup, DetailRow } from "@/components/molecules/detail-group";
import {
  attachReceipt,
  deleteReceipt,
  detachReceipt,
  fetchReceipts,
  fetchUnmatchedReceipts,
  uploadReceipt,
  type ReceiptSummary,
  type UnmatchedReceipt,
} from "@/actions/receipts";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Optional receipts for one transaction. Nothing here gates reviewing,
 * budgets or reports; with no receipt the section is just an Attach button.
 */
export function ReceiptsSection({
  transactionId,
  categories,
  onSplitsChanged,
}: {
  transactionId: string;
  categories: CategoryGroup[];
  onSplitsChanged: () => void;
}) {
  const [items, setItems] = useState<ReceiptSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [waiting, setWaiting] = useState<UnmatchedReceipt[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchReceipts(transactionId).then((res) => {
      if (cancelled) return;
      if ("data" in res) setItems(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [transactionId]);

  function upload(files: FileList | File[]) {
    setError(null);
    startTransition(async () => {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.set("file", file);
        const res = await uploadReceipt(transactionId, fd);
        if ("error" in res) {
          setError(`${file.name}: ${res.error}`);
        } else {
          setItems((prev) => [res.data, ...prev]);
        }
      }
    });
  }

  function togglePicker() {
    if (waiting) {
      setWaiting(null);
      return;
    }
    startTransition(async () => {
      const res = await fetchUnmatchedReceipts();
      if ("data" in res) setWaiting(res.data);
    });
  }

  function attachExisting(receiptId: string) {
    setError(null);
    startTransition(async () => {
      const res = await attachReceipt(receiptId, transactionId);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setWaiting(null);
      const list = await fetchReceipts(transactionId);
      if ("data" in list) setItems(list.data);
    });
  }

  function detach(id: string) {
    setError(null);
    startTransition(async () => {
      const res = await detachReceipt(id);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setItems((prev) => prev.filter((r) => r.id !== id));
      onSplitsChanged(); // splits made from its items are gone
    });
  }

  function remove(id: string, filename: string) {
    if (!window.confirm(`Delete ${filename}? The file is removed permanently.`)) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteReceipt(id);
      if ("error" in res) setError(res.error);
      else setItems((prev) => prev.filter((r) => r.id !== id));
    });
  }

  return (
    <div
      className="mt-3.5"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length > 0) upload(e.dataTransfer.files);
      }}
    >
      <DetailGroup className={dragging ? "ring-2 ring-primary" : undefined}>
        <DetailRow
          label="Receipts"
          hint={items.length === 0 ? "Optional. Drop a file here or attach one" : undefined}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.txt,.eml"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) upload(e.target.files);
              e.target.value = "";
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-7 rounded-full text-xs"
            onClick={() => inputRef.current?.click()}
            disabled={pending}
          >
            {pending ? <Loader2 className="mr-1 size-3 animate-spin" aria-hidden /> : <Paperclip className="mr-1 size-3" aria-hidden />}
            {pending ? "Reading receipt…" : "Attach"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 rounded-full text-xs"
            onClick={togglePicker}
            disabled={pending}
          >
            Choose existing
          </Button>
        </DetailRow>
        {items.map((r) => (
          <div key={r.id}>
          <div className="flex min-h-[44px] items-center justify-between gap-2 px-3.5 py-1.5">
            <a
              href={`/api/receipts/${r.id}`}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 items-center gap-2 text-sm hover:underline"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{r.originalFilename}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatSize(r.sizeBytes)}</span>
            </a>
            <div className="flex shrink-0 items-center">
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`Remove ${r.originalFilename} from this transaction`}
                title="Remove from this transaction (keeps the file)"
                onClick={() => detach(r.id)}
                disabled={pending}
              >
                <Unlink className="size-3.5" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`Delete receipt ${r.originalFilename}`}
                title="Delete the receipt file"
                onClick={() => remove(r.id, r.originalFilename)}
                disabled={pending}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            </div>
          </div>
          <ReceiptItems receiptId={r.id} categories={categories} onSplitsChanged={onSplitsChanged} />
          </div>
        ))}
        {waiting &&
          (waiting.length === 0 ? (
            <p className="px-3.5 py-3 text-xs text-muted-foreground">No unmatched receipts.</p>
          ) : (
            waiting.map((r) => (
              <div key={r.id} className="flex min-h-[44px] items-center justify-between gap-2 px-3.5 py-1.5">
                <span className="min-w-0 truncate text-sm">
                  {r.originalFilename}
                  {r.hintTotalCents !== null && (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {centsToDisplay(r.hintTotalCents)}
                    </span>
                  )}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0 rounded-full text-xs"
                  onClick={() => attachExisting(r.id)}
                  disabled={pending}
                >
                  Attach here
                </Button>
              </div>
            ))
          ))}
      </DetailGroup>
      {error && (
        <p role="alert" className="mt-1.5 px-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
