"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  importAmazonOrders,
  previewAmazonImport,
  type AmazonPreview,
} from "@/actions/amazon-import";
import type { AmazonImportResult } from "@/lib/receipts/amazon-import";

/** Backfills itemized receipts from an Amazon order-history export. Preview first, then import. */
export function AmazonImport() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<AmazonPreview | null>(null);
  const [result, setResult] = useState<AmazonImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function form(f: File) {
    const fd = new FormData();
    fd.set("file", f);
    return fd;
  }

  function choose(f: File | null) {
    setFile(f);
    setPreview(null);
    setResult(null);
    setError(null);
    if (!f) return;
    startTransition(async () => {
      const res = await previewAmazonImport(form(f));
      if ("error" in res) setError(res.error);
      else setPreview(res.data);
    });
  }

  function run() {
    if (!file) return;
    setError(null);
    startTransition(async () => {
      const res = await importAmazonOrders(form(file));
      if ("error" in res) setError(res.error);
      else {
        setResult(res.data);
        setPreview(null);
      }
    });
  }

  return (
    <section aria-label="Amazon order history" className="space-y-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div>
        <h2 className="text-sm font-medium">Backfill from Amazon order history</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose Order History.csv from your Amazon data export (Your Orders). Each shipment is matched to its charge
          by amount and date, saved as a receipt with every item, and filed in your receipts folder. No AI is used,
          and running it again is safe. Orders paid partly with a gift card won&apos;t match.
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        hidden
        onChange={(e) => {
          choose(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
      <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={pending}>
        {pending && !preview ? "Reading…" : file ? "Choose a different file" : "Choose file"}
      </Button>
      {file && <span className="ml-2 text-xs text-muted-foreground">{file.name}</span>}

      {preview && (
        <div className="space-y-2 text-sm">
          <ul className="space-y-0.5">
            <li>{preview.orderLines} order lines in the file</li>
            <li>
              <strong>{preview.toImport}</strong> match an Amazon charge and will be imported (
              {preview.itemsToImport} items)
            </li>
            {preview.alreadyItemized > 0 && <li>{preview.alreadyItemized} already have itemized receipts (skipped)</li>}
            <li>{preview.amazonChargesWithoutOrder} Amazon charges have no order in the file</li>
          </ul>
          <Button size="sm" onClick={run} disabled={pending || preview.toImport === 0}>
            {pending ? "Importing…" : `Import ${preview.toImport} orders`}
          </Button>
        </div>
      )}

      {result && (
        <p className="text-sm">
          Imported {result.imported} receipts with {result.items} items.
          {result.skipped > 0 && ` ${result.skipped} skipped.`}
          {result.duplicates > 0 && ` ${result.duplicates} already imported.`}
          {result.failed > 0 && ` ${result.failed} failed.`}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
