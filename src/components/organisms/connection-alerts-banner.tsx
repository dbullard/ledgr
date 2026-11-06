"use client";

import type { ReactNode } from "react";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import type { ConnectionAlert } from "@/lib/connection-alerts";

/** Where a SimpleFIN user re-enters bank credentials / MFA. Bridges are self-hostable, so this is the public default. */
export const SIMPLEFIN_BRIDGE_URL = "https://bridge.simplefin.org/simplefin";

export function SimplefinBridgeLink({ label = "Open SimpleFIN Bridge" }: { label?: string }) {
  return (
    <a
      href={SIMPLEFIN_BRIDGE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
    >
      {label}
      <ExternalLink className="size-3.5 ml-1" aria-hidden />
    </a>
  );
}

interface ConnectionAlertsBannerProps {
  alerts: ConnectionAlert[];
  /** Provider-specific fix (Plaid Link, SimpleFIN token dialog, Bridge link). */
  renderAction: (alert: ConnectionAlert) => ReactNode;
}

/**
 * Pinned list of banks that need attention. The per-bank header carries the
 * same information, but only in the "By institution" view; this keeps a
 * reauthentication request visible however the page is grouped.
 */
export function ConnectionAlertsBanner({ alerts, renderAction }: ConnectionAlertsBannerProps) {
  if (alerts.length === 0) return null;

  return (
    <div role="alert" className="space-y-2">
      {alerts.map((a) => (
        <div
          key={a.connectionId}
          className={cn(
            "flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3",
            a.tone === "destructive" ? "border-destructive/40 bg-destructive/5" : "border-amber-500/40 bg-amber-500/5",
          )}
        >
          <div className="flex min-w-0 items-start gap-3">
            <AlertTriangle
              className={cn("mt-0.5 size-4 shrink-0", a.tone === "destructive" ? "text-destructive" : "text-amber-500")}
              aria-hidden
            />
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {a.institutionName} · {a.label}
              </p>
              <p className="text-xs text-muted-foreground">{a.detail}</p>
            </div>
          </div>
          {renderAction(a)}
        </div>
      ))}
    </div>
  );
}
