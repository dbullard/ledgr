import SwiftUI

/// Cross-scene commands (menu bar items on Mac, buttons everywhere).
@MainActor
final class AppActions: ObservableObject {
    @Published var showImporter = false
    @Published var showSettings = false
    @Published var showScanner = false
    @Published var showPhotoPicker = false
    @Published var reloadTick = 0
}

@main
struct LedgrApp: App {
    @StateObject private var connection: Connection
    @StateObject private var web: WebModel
    @StateObject private var queue = UploadQueue()
    @StateObject private var actions = AppActions()
    @StateObject private var api: API

    init() {
        let connection = Connection()
        let web = WebModel()
        _connection = StateObject(wrappedValue: connection)
        _web = StateObject(wrappedValue: web)
        _api = StateObject(wrappedValue: API(connection: connection, web: web))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(connection)
                .environmentObject(web)
                .environmentObject(queue)
                .environmentObject(actions)
                .environmentObject(api)
                #if os(macOS)
                .frame(minWidth: 900, minHeight: 600)
                #endif
        }
        .commands {
            CommandGroup(after: .newItem) {
                Button("Upload Receipt…") { actions.showImporter = true }
                    .keyboardShortcut("u", modifiers: [.command])
            }
            CommandGroup(replacing: .appSettings) {
                Button("Settings…") { actions.showSettings = true }
                    .keyboardShortcut(",", modifiers: [.command])
            }
        }
    }
}
