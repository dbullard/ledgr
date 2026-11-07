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

/// Which notifications the household gets and when (stored on the server, so it applies to every device).
struct PushPrefs: Codable, Equatable {
    var bills = true
    var largeCharges = true
    var budgets = true
    var connections = true
    var largeChargeCents = 25_000
    var quietEnabled = true
    var quietStartHour = 21
    var quietEndHour = 8
}

/// Settings card: turn notifications on, choose which kinds to receive, set quiet hours, send a test.
struct NotificationsCard: View {
    @EnvironmentObject var api: API
    @ObservedObject private var push = PushManager.shared
    @State private var testResult: String?
    @State private var sending = false
    @State private var prefs: PushPrefs?
    @State private var prefsError: String?

    private static let thresholds = [5_000, 10_000, 25_000, 50_000, 100_000, 250_000]

    var body: some View {
        Group {
        Card("Notifications") {
            if push.isEnabled {
                Label("On for this device", systemImage: "bell.badge.fill").foregroundStyle(.green)
            } else {
                Button("Turn on notifications") { Task { await push.enable() } }.buttonStyle(.bordered)
            }
            if let message = push.message { Text(message).font(.caption).foregroundStyle(.red) }
        }
        if let prefs {
            Card("Notify me about") {
                toggle("Bills due", "Today and tomorrow", \.bills)
                toggle("Large charges", "Single charges over the amount below", \.largeCharges)
                if prefs.largeCharges {
                    Picker("Large means", selection: binding(\.largeChargeCents)) {
                        ForEach(options(prefs.largeChargeCents), id: \.self) { Text("$\($0 / 100)+").tag($0) }
                    }
                }
                toggle("Budgets", "At 80% and when a category goes over", \.budgets)
                toggle("Bank connections", "When a bank needs you to sign in again", \.connections)
            }
            Card("Quiet hours") {
                Toggle("Hold notifications overnight", isOn: binding(\.quietEnabled))
                if prefs.quietEnabled {
                    Picker("From", selection: binding(\.quietStartHour)) { hours }
                    Picker("Until", selection: binding(\.quietEndHour)) { hours }
                }
                Text("Alerts that come up during quiet hours are sent at the first check after they end.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } else if let prefsError {
            Text(prefsError).font(.caption).foregroundStyle(.red)
        }
        if push.isEnabled {
            Card {
                Button(sending ? "Sending…" : "Send a test notification") {
                    Task {
                        sending = true
                        testResult = await push.sendTest(using: api)
                        sending = false
                    }
                }
                .buttonStyle(.bordered)
                .disabled(sending)
                if let testResult { Text(testResult).font(.caption).foregroundStyle(.secondary) }
                Text("Your server decides what to send and delivers it through Apple's push service. Nothing goes through anyone else.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        }
        .task {
            await push.refreshPermission()
            await loadPrefs()
        }
    }

    private var hours: some View {
        ForEach(0..<24, id: \.self) { h in
            Text(Calendar.current.date(bySettingHour: h, minute: 0, second: 0, of: Date())?
                .formatted(.dateTime.hour()) ?? "\(h):00").tag(h)
        }
    }

    private func options(_ current: Int) -> [Int] {
        Array(Set(Self.thresholds + [current])).sorted()
    }

    private func toggle(_ title: String, _ detail: String, _ key: WritableKeyPath<PushPrefs, Bool>) -> some View {
        Toggle(isOn: binding(key)) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func binding<V>(_ key: WritableKeyPath<PushPrefs, V>) -> Binding<V> {
        Binding(
            get: { (prefs ?? PushPrefs())[keyPath: key] },
            set: { value in
                guard var next = prefs else { return }
                next[keyPath: key] = value
                prefs = next
                Task { await save(next) }
            }
        )
    }

    private func loadPrefs() async {
        do { prefs = try await api.get("api/native/push/preferences"); prefsError = nil }
        catch { if prefs == nil { prefsError = "Couldn't load notification settings." } }
    }

    private func save(_ next: PushPrefs) async {
        do {
            let body: [String: Any] = [
                "bills": next.bills, "largeCharges": next.largeCharges, "budgets": next.budgets,
                "connections": next.connections, "largeChargeCents": next.largeChargeCents,
                "quietEnabled": next.quietEnabled, "quietStartHour": next.quietStartHour,
                "quietEndHour": next.quietEndHour,
            ]
            prefs = try await api.patch("api/native/push/preferences", body: body)
            prefsError = nil
        } catch {
            prefsError = "Couldn't save that change."
            await loadPrefs()
        }
    }
}
