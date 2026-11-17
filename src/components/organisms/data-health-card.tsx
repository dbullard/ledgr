import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelativeTime } from "@/lib/relative-time";
import type { BackupStatus, Health, HealthLevel } from "@/lib/data-health";
import type { ConnectionHealthRow } from "@/queries/data-health";

const DOT: Record<HealthLevel, string> = {
  ok: "bg-emerald-500",
  warning: "bg-amber-500",
  problem: "bg-destructive",
};
const LEVEL_WORD: Record<HealthLevel, string> = {
  ok: "Healthy",
  warning: "Needs a look",
  problem: "Needs attention",
};

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function Row({ title, detail, health }: { title: string; detail?: string; health: Health }) {
  return (
    <li className="flex items-start gap-3 py-3" data-level={health.level}>
      {/* Color is never the only signal: the status word is read out and shown. */}
      <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${DOT[health.level]}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <p className="font-medium break-words">{title}</p>
          <p className="text-xs text-muted-foreground">
            <span className="sr-only">{LEVEL_WORD[health.level]}: </span>
            {health.summary}
          </p>
        </div>
        {detail && <p className="text-xs text-muted-foreground mt-0.5">{detail}</p>}
      </div>
    </li>
  );
}

interface DataHealthCardProps {
  connections: ConnectionHealthRow[];
  backup: { status: BackupStatus | null; health: Health };
}

export function DataHealthCard({ connections, backup }: DataHealthCardProps) {
  const backupDetail = backup.status?.lastSuccessAt
    ? [
        `Last good backup ${formatRelativeTime(backup.status.lastSuccessAt)}`,
        backup.status.sizeBytes != null ? formatBytes(backup.status.sizeBytes) : null,
        backup.status.count > 0 ? `${backup.status.count} kept` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;

  return (
    <Card data-testid="data-health-card">
      <CardHeader>
        <CardTitle>Data health</CardTitle>
        <CardDescription>
          Whether your banks are syncing and your database is being backed up.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          <Row title="Database backup" detail={backupDetail} health={backup.health} />
          {connections.map((c) => (
            <Row
              key={c.connectionId}
              title={c.institutionName}
              detail={
                [
                  c.lastSyncAt ? `Synced ${formatRelativeTime(c.lastSyncAt)}` : null,
                  c.lastDataAt ? `bank data ${formatRelativeTime(c.lastDataAt)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || undefined
              }
              health={c.health}
            />
          ))}
        </ul>
        {connections.length === 0 && (
          <p className="pt-3 text-sm text-muted-foreground">No bank connections yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
