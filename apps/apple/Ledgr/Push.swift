import SwiftUI
import UserNotifications
#if os(iOS)
import UIKit
#endif

/// Push notifications from your own server. The Ledgr server on the NAS decides
/// what to tell you (bills, large charges, budgets, bank problems) and sends it
/// straight to Apple's push service; this side only asks permission and hands
/// the server this device's token.
@MainActor
final class PushManager: ObservableObject {
    static let shared = PushManager()

    @Published private(set) var permission: UNAuthorizationStatus = .notDetermined
    @Published private(set) var message: String?

    private let defaults = UserDefaults.standard
    private let center = UNUserNotificationCenter.current()

    /// Debug builds get sandbox tokens, TestFlight/App Store builds get production ones.
    /// The server also retries the other host, so a Release build installed from Xcode still works.
    private var environment: String {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }

    private var token: String? {
        get { defaults.string(forKey: "apnsToken") }
        set { defaults.set(newValue, forKey: "apnsToken") }
    }

    var isEnabled: Bool {
        switch permission {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }

    func refreshPermission() async {
        permission = await center.notificationSettings().authorizationStatus
    }

    /// Asks iOS for permission (the first time) and registers with APNs.
    func enable() async {
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            await refreshPermission()
            if granted {
                message = nil
                registerWithAPNs()
            } else {
                message = "Notifications are off for Ledgr. Turn them on in the iOS Settings app."
            }
        } catch {
            message = error.localizedDescription
        }
    }

    /// Called at launch and after sign-in: if permission was already granted, make sure the
    /// token is fresh and the server has it.
    func registerIfAllowed() async {
        await refreshPermission()
        guard isEnabled else { return }
        registerWithAPNs()
        await syncRegistration()
    }

    private func registerWithAPNs() {
        #if os(iOS)
        UIApplication.shared.registerForRemoteNotifications()
        #endif
    }

    func didRegister(deviceToken data: Data) {
        token = data.map { String(format: "%02x", $0) }.joined()
        Task { await syncRegistration() }
    }

    func didFail(_ error: Error) {
        message = "Couldn't register for notifications: \(error.localizedDescription)"
    }

    /// Tells the server about this device. Idempotent, so it is safe to call whenever.
    func syncRegistration() async {
        guard let api = AppContext.shared.api, api.auth == .signedIn, let token else { return }
        do {
            try await api.post("api/native/push/register", body: ["token": token, "environment": environment])
        } catch APIError.unauthorized {
            // Signed out meanwhile; registration happens again at the next sign-in.
        } catch {
            message = "Couldn't reach your server to turn notifications on."
        }
    }

    /// Stops this device receiving pushes for the account that is signing out.
    func unregister(using api: API) async {
        guard let token else { return }
        try? await api.delete("api/native/push/register", query: ["token": token])
    }

    /// Asks the server to push a test notification to the household's devices.
    func sendTest(using api: API) async -> String {
        do {
            try await api.post("api/native/push/test", body: [:])
            return "Sent. It should arrive in a few seconds."
        } catch {
            return error.localizedDescription
        }
    }
}

#if os(iOS)
/// UIKit callbacks SwiftUI doesn't expose: the APNs token and foreground presentation.
@MainActor
final class PushAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        Task { await PushManager.shared.registerIfAllowed() }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushManager.shared.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushManager.shared.didFail(error)
    }

    /// Show the banner even while the app is open.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }
}
#endif

/// Settings card: turn notifications on, and send a test from the server.
struct NotificationsCard: View {
    @EnvironmentObject var api: API
    @ObservedObject private var push = PushManager.shared
    @State private var testResult: String?
    @State private var sending = false

    var body: some View {
        Card("Notifications") {
            if push.isEnabled {
                Label("On for this device", systemImage: "bell.badge.fill").foregroundStyle(.green)
                Button(sending ? "Sending…" : "Send a test notification") {
                    Task {
                        sending = true
                        testResult = await push.sendTest(using: api)
                        sending = false
                    }
                }
                .buttonStyle(.bordered)
                .disabled(sending)
            } else {
                Button("Turn on notifications") { Task { await push.enable() } }.buttonStyle(.bordered)
            }
            if let testResult { Text(testResult).font(.caption).foregroundStyle(.secondary) }
            if let message = push.message { Text(message).font(.caption).foregroundStyle(.red) }
            Text("Your server sends bills due, large charges, budgets at 80% and 100%, and bank connections that need attention. Nothing goes through anyone but Apple's delivery service.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .task { await push.refreshPermission() }
    }
}
