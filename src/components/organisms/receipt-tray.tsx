"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { FileText, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  attachReceipt,
  deleteReceipt,
  fetchUnmatchedReceipts,
  uploadUnmatchedReceipt,
  type UnmatchedReceipt,
} from "@/actions/receipts";
import { centsToDisplay } from "@/lib/money";
import { formatDateShort } from "@/lib/date-utils";

/** Receipts waiting for a transaction, with one-click suggested matches. */
export function ReceiptTray() {
  const [items, setItems] = useState<UnmatchedReceipt[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const res = await fetchUnmatchedReceipts();
    if ("data" in res) setItems(res.data);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchUnmatchedReceipts().then((res) => {
      if (!cancelled && "data" in res) setItems(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function upload(files: FileList | File[]) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      let attached = 0;
      let waiting = 0;
      let duplicates = 0;
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.set("file", file);
        const res = await uploadUnmatchedReceipt(fd);
        if ("error" in res) setError(`${file.name}: ${res.error}`);
        else if (res.status === "attached") attached++;
        else if (res.status === "duplicate") duplicates++;
        else waiting++;
      }
      const parts = [
        attached && `${attached} attached automatically`,
        waiting && `${waiting} waiting for a match`,
        duplicates && `${duplicates} already uploaded`,
      ].filter(Boolean);
      if (parts.length) setMessage(parts.join(", "));
      await reload();
    });
  }

  function attach(receiptId: string, transactionId: string) {
    setError(null);
    startTransition(async () => {
      const res = await attachReceipt(receiptId, transactionId);
      if ("error" in res) setError(res.error);
      await reload();
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const res = await deleteReceipt(id);
      if ("error" in res) setError(res.error);
      await reload();
    });
  }

  return (
    <div className="space-y-4">
      <div
        className={`flex flex-col items-center gap-2 rounded-xl border border-dashed p-6 text-center ${
          dragging ? "border-primary bg-primary/5" : "border-border"
        }`}
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
        <Upload className="size-5 text-muted-foreground" aria-hidden />
        <p className="text-sm">Drop receipts here (PDF, image, text or email)</p>
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
        <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={pending}>
          {pending ? "Working…" : "Choose files"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Files dropped in the <code>inbox</code> folder of your receipts share are picked up
          automatically.
        </p>
      </div>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <section aria-label="Unmatched receipts" className="space-y-3">
        <h2 className="text-sm font-medium">
          Waiting for a transaction{items ? ` (${items.length})` : ""}
        </h2>
        {items === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing waiting.</p>
        ) : (
          items.map((r) => (
            <div key={r.id} className="space-y-2 rounded-xl bg-card p-3.5 ring-1 ring-foreground/10">
              <div className="flex items-center justify-between gap-2">
                <a
                  href={`/api/receipts/${r.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-w-0 items-center gap-2 text-sm hover:underline"
                >
                  <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{r.originalFilename}</span>
                </a>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  aria-label={`Delete receipt ${r.originalFilename}`}
                  onClick={() => remove(r.id)}
                  disabled={pending}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {[
                  r.hintTotalCents !== null && `Total ${centsToDisplay(r.hintTotalCents)}`,
                  r.hintDate && formatDateShort(r.hintDate),
                  r.hintMerchant,
                ]
                  .filter(Boolean)
                  .join(" · ") || "Couldn't read details from this file"}
              </p>
              {r.suggestions.length > 0 ? (
                <ul className="space-y-1.5">
                  {r.suggestions.map((s) => (
                    <li key={s.transactionId} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate">
                        {s.name} · {centsToDisplay(s.amountCents)} · {formatDateShort(s.date)}
                        <span className="ml-1 text-xs text-muted-foreground">({s.reasons.join(", ")})</span>
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 shrink-0 rounded-full text-xs"
                        onClick={() => attach(r.id, s.transactionId)}
                        disabled={pending}
                      >
                        Attach
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No likely transaction found. Open the transaction and choose this receipt there.
                </p>
              )}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
