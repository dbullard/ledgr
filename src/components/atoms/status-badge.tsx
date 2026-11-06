import { cn } from "@/lib/utils";
import { describeConnectionIssue } from "@/lib/connection-issue";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ConnectionStatus } from "@/db/schema/bank-connections";

interface StatusBadgeProps {
  status: ConnectionStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
}

const config = {
  active: { label: "Connected", dotClass: "bg-positive" },
  error: { label: "Error", dotClass: "bg-amber-500" },
  reauth_required: { label: "Reconnect needed", dotClass: "bg-destructive" },
  revoked: { label: "Access revoked", dotClass: "bg-destructive" },
  pending_classification: { label: "Setting up", dotClass: "bg-amber-500" },
} as const;

export function StatusBadge({ status, errorCode, errorMessage }: StatusBadgeProps) {
  const issue = describeConnectionIssue({ status, errorCode: errorCode ?? null, errorMessage: errorMessage ?? null });
  if (issue) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-help bg-transparent border-0 p-0">
            <span
              className={cn("size-1.5 rounded-full", issue.tone === "destructive" ? "bg-destructive" : "bg-amber-500")}
              aria-hidden
            />
            {issue.label}
          </TooltipTrigger>
          <TooltipContent>
            <p>{issue.detail}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  const { label, dotClass } = config[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", dotClass)} aria-hidden />
      {label}
    </span>
  );
}
