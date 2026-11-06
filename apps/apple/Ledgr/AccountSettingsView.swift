import SwiftUI

struct SettingsUser: Codable { let name: String?; let email: String }

struct McpClient: Codable, Identifiable {
    let clientId: String
    let clientName: String?
    let scope: String
    let grantedAt: String
    var id: String { clientId }
}

struct SettingsResponse: Codable {
    let user: SettingsUser
    let demoEnabled: Bool
    let mcpEnabled: Bool
    let connectedClients: [McpClient]
}

/// App-wide appearance choice, stored on this device.
enum AppearanceChoice: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var scheme: ColorScheme? {
        switch self { case .system: return nil; case .light: return .light; case .dark: return .dark }
    }
}

struct AccountSettingsView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var connection: Connection
    @EnvironmentObject var actions: AppActions
    @EnvironmentObject var web: WebModel
    @AppStorage("appearance") private var appearance = AppearanceChoice.system.rawValue
    @State private var data: SettingsResponse?
    @State private var error: String?
    @State private var note: String?
    @State private var confirmSignOut = false

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let data {
                    Card("Account") {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(data.user.name ?? data.user.email).font(.headline)
                            if data.user.name != nil { Text(data.user.email).font(.subheadline).foregroundStyle(.secondary) }
                        }
                        Button("Sign out", role: .destructive) { confirmSignOut = true }.buttonStyle(.bordered)
                    }
                } else if let error {
                    ErrorState(message: error) { Task { await load() } }
                }

                Card("Appearance") {
                    Picker("Theme", selection: $appearance) {
                        ForEach(AppearanceChoice.allCases) { Text($0.rawValue.capitalized).tag($0.rawValue) }
                    }
                    .pickerStyle(.segmented)
                    Text("Applies to this device only.").font(.caption).foregroundStyle(.secondary)
                }

                if let data {
                    Card("Demo mode") {
                        Toggle("Show demo data", isOn: Binding(get: { data.demoEnabled }, set: { _ in Task { await toggleDemo() } }))
                        Text("Demo mode is read-only and hides your real accounts. Reload screens after changing it.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Card("AI assistant access (MCP)") {
                        Toggle("Allow connected assistants", isOn: Binding(get: { data.mcpEnabled }, set: { v in Task { await setMcp(v) } }))
                        if data.connectedClients.isEmpty {
                            Text("No assistants connected.").font(.caption).foregroundStyle(.secondary)
                        }
                        ForEach(data.connectedClients) { c in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(c.clientName ?? c.clientId).font(.body)
                                    Text(c.scope).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer()
                                Button("Revoke", role: .destructive) { Task { await revoke(c) } }.buttonStyle(.bordered).controlSize(.small)
                            }
                        }
                    }
                }

                Card("Server") {
                    HStack {
                        Label(connection.mode.label, systemImage: connection.mode.symbol)
                        Spacer()
                        Button("Addresses…") { actions.showSettings = true }.buttonStyle(.bordered)
                    }
                    if let url = connection.active { Text(url.absoluteString).font(.caption).foregroundStyle(.secondary) }
                }

                Card("More in the web app") {
                    Text("Passkeys, deleting your account and wiping data are only in the web app, on purpose.")
                        .font(.footnote).foregroundStyle(.secondary)
                    NavigationLink(value: WebPage(title: "Web settings", path: "/settings", symbol: "gearshape")) {
                        Label("Open web settings", systemImage: "safari")
                    }
                }
                if let note { Text(note).font(.footnote).foregroundStyle(Color.alert) }
            }
            .padding()
        }
        .background(Color.canvas)
        .navigationTitle("Settings")
        .refreshable { await load() }
        .task(id: connection.active) { await load() }
        .confirmationDialog("Sign out of Ledgr?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await api.signOut() } }
        }
    }

    private func load() async {
        do { data = try await api.get("api/native/settings"); error = nil }
        catch APIError.unauthorized {}
        catch { if data == nil { self.error = error.localizedDescription } }
    }

    private func toggleDemo() async {
        do { try await api.post("api/native/settings/demo-mode", body: [:]); actions.reloadTick += 1; await load() }
        catch { note = error.localizedDescription }
    }

    private func setMcp(_ on: Bool) async {
        do { let _: Ok = try await api.patch("api/native/settings/mcp", body: ["enabled": on]); await load() }
        catch { note = error.localizedDescription }
    }

    private func revoke(_ c: McpClient) async {
        do { try await api.delete("api/native/settings/mcp/\(c.clientId)"); await load() }
        catch { note = error.localizedDescription }
    }
}
