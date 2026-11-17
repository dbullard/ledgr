import { getSession, getHouseholdId } from "@/lib/auth/session";
import { getMcpSettings } from "@/queries/mcp-settings";
import { McpSettingsForm } from "@/components/organisms/mcp-settings-form";
import { DemoModeToggle } from "@/components/molecules/demo-mode-toggle";
import { AppearanceToggle } from "@/components/molecules/appearance-toggle";
import { PasskeysManager } from "@/components/organisms/passkeys-manager";
import { DangerZone } from "@/components/organisms/danger-zone";
import { isDemoMode } from "@/lib/demo-mode";
import { DataHealthCard } from "@/components/organisms/data-health-card";
import { getConnectionHealth } from "@/queries/data-health";
import { readBackupStatus } from "@/lib/backup-status";
import { evaluateBackupHealth } from "@/lib/data-health";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) return null;

  const [mcpSettings, demoEnabled, connections, backupStatus] = await Promise.all([
    getMcpSettings(session.user.id),
    isDemoMode(session.user.id),
    getConnectionHealth(await getHouseholdId()),
    readBackupStatus(),
  ]);
  const backup = { status: backupStatus, health: evaluateBackupHealth(backupStatus, new Date()) };

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure integrations and access controls.
        </p>
      </div>
      <DataHealthCard connections={connections} backup={backup} />
      <AppearanceToggle />
      <DemoModeToggle initialEnabled={demoEnabled} />
      <PasskeysManager />
      <McpSettingsForm
        mcpEnabled={mcpSettings.mcpEnabled}
        connectedClients={mcpSettings.connectedClients}
      />
      <DangerZone />
    </div>
  );
}
