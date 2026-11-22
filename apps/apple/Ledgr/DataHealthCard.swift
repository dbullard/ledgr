import SwiftUI

/// Whether bank connections are syncing and the database is being backed up (the web Settings card).
struct DataHealthCard: View {
    @EnvironmentObject var api: API

    private struct Health: Codable { let level: String; let summary: String }
    private struct Conn: Codable, Identifiable {
        let connectionId: String
        let institutionName: String
        let lastSyncAt: String?
        let lastDataAt: String?
        let health: Health
        var id: String { connectionId }
    }
    private struct Backup: Codable { let lastSuccessAt: String?; let sizeBytes: Int?; let count: Int? }
    private struct BackupBlock: Codable { let status: Backup?; let health: Health }
    private struct Response: Codable { let backup: BackupBlock; let connections: [Conn] }

    @State private var data: Response?

    var body: some View {
        Group {
            if let data {
                Card("Data health") {
                    row("Database backup", detail: backupDetail(data.backup), health: data.backup.health)
                    ForEach(data.connections) { c in
                        Divider()
                        row(c.institutionName, detail: nil, health: c.health)
                    }
                }
            }
        }
        .task { data = try? await api.get("api/native/data-health") }
    }

    private func backupDetail(_ b: BackupBlock) -> String? {
        guard let s = b.status, let last = s.lastSuccessAt else { return nil }
        return "Last good backup \(Fmt.shortDate(String(last.prefix(10))))"
    }

    private func row(_ title: String, detail: String?, health: Health) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(color(health.level)).frame(width: 10, height: 10).padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.medium))
                Text(health.summary).font(.caption).foregroundStyle(.secondary)
                if let detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
        }
        .accessibilityElement(children: .combine)
    }

    private func color(_ level: String) -> Color {
        switch level { case "ok": return .income; case "warning": return .orange; default: return .alert }
    }
}
