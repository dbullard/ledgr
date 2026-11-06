import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var connection: Connection
    @EnvironmentObject var web: WebModel
    @EnvironmentObject var queue: UploadQueue
    @Environment(\.dismiss) private var dismiss
    var firstRun = false
    @State private var homeStatus: String?
    @State private var awayStatus: String?
    @State private var confirmClear = false

    var body: some View {
        Form {
            Section {
                TextField("http://192.168.1.50:4200", text: $connection.homeText)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    #endif
                if let homeStatus { Text(homeStatus).font(.footnote).foregroundStyle(.secondary) }
            } header: {
                Text("Home address")
            } footer: {
                Text("Your server's address on your home network. Tried first.")
            }

            Section {
                TextField("https://ledgr.your-tailnet.ts.net", text: $connection.awayText)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    #endif
                if let awayStatus { Text(awayStatus).font(.footnote).foregroundStyle(.secondary) }
            } header: {
                Text("Away address")
            } footer: {
                Text("Your VPN or proxy address, used when the home address can't be reached. Optional.")
            }

            Section {
                Button("Test connection") { Task { await test() } }
                if !firstRun {
                    LabeledContent("Using", value: connection.active?.absoluteString ?? "—")
                    LabeledContent("Connection", value: connection.mode.label)
                }
            }

            if !firstRun {
                Section("Waiting to upload") {
                    if queue.items.isEmpty {
                        Text("Nothing waiting").foregroundStyle(.secondary)
                    } else {
                        ForEach(queue.items) { item in
                            Text(item.filename)
                        }
                        .onDelete { offsets in offsets.map { queue.items[$0] }.forEach(queue.remove) }
                    }
                }
                Section {
                    Button("Sign out and clear app data", role: .destructive) { confirmClear = true }
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(firstRun ? "Connect to Ledgr" : "Settings")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(firstRun ? "Connect" : "Done") {
                    connection.setupComplete = true
                    connection.scheduleRefresh(after: .milliseconds(50))
                    dismiss()
                }
                .disabled(!connection.isConfigured)
            }
        }
        .confirmationDialog("Clear sign-in and cached data?", isPresented: $confirmClear) {
            Button("Clear", role: .destructive) { Task { await web.clearWebsiteData() } }
        }
    }

    private func test() async {
        homeStatus = connection.homeURL == nil ? nil : "Checking…"
        awayStatus = connection.awayURL == nil ? nil : "Checking…"
        if let home = connection.homeURL {
            homeStatus = await Connection.probe(home, timeout: 4) ? "Reachable" : "Not reachable from here"
        }
        if let away = connection.awayURL {
            awayStatus = await Connection.probe(away, timeout: 6) ? "Reachable" : "Not reachable from here"
        }
    }
}
