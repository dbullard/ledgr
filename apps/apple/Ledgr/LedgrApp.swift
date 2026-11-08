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
    @StateObject private var actions: AppActions
    @StateObject private var api: API
    @AppStorage("appearance") private var appearance = AppearanceChoice.system.rawValue
    #if os(iOS)
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    #endif

    init() {
        let connection = Connection()
        let web = WebModel()
        let actions = AppActions()
        _actions = StateObject(wrappedValue: actions)
        AppContext.shared.actions = actions
        _connection = StateObject(wrappedValue: connection)
        _web = StateObject(wrappedValue: web)
        let api = API(connection: connection, web: web)
        _api = StateObject(wrappedValue: api)
        AppContext.shared.api = api
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(connection)
                .environmentObject(web)
                .environmentObject(queue)
                .environmentObject(actions)
                .environmentObject(api)
                .preferredColorScheme(AppearanceChoice(rawValue: appearance)?.scheme)
                .onChange(of: api.auth) { _, state in
                    if state == .signedIn { Task { await PushManager.shared.registerIfAllowed() } }
                }
                #if os(macOS)
                .frame(minWidth: 900, minHeight: 600)
                .background(WindowBackdrop())
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
