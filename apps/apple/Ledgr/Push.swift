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
    var enabled = true
    var bills = true
    var largeCharges = true
    var largeChargeCents = 25_000
    var deposits = false
    var depositCents = 50_000
    var lowBalance = false
    var lowBalanceCents = 10_000
    var budgets = true
    var weekly = false
    var review = false
    var connections = true
    var quietEnabled = true
    var quietStartHour = 21
    var quietEndHour = 8

    /// How many of the eight alert types are switched on.
    var activeTypes: Int {
        [bills, largeCharges, deposits, lowBalance, budgets, weekly, review, connections].filter { $0 }.count
    }
}

/// Loads and saves the household's notification choices. Edits apply instantly on screen and are
/// sent to the server in the background; a failure rolls the screen back to what the server has.
@MainActor
final class PushPrefsStore: ObservableObject {
    @Published private(set) var prefs: PushPrefs?
    @Published private(set) var error: String?

    func load(using api: API) async {
        do { prefs = try await api.get("api/native/push/preferences"); error = nil }
        catch { if prefs == nil { self.error = "Couldn't load notification settings." } }
    }

    func update(_ change: (inout PushPrefs) -> Void, using api: API) {
        guard var next = prefs else { return }
        change(&next)
        prefs = next
        Task {
            do {
                let body: [String: Any] = [
                    "enabled": next.enabled, "bills": next.bills, "largeCharges": next.largeCharges,
                    "largeChargeCents": next.largeChargeCents, "deposits": next.deposits,
                    "depositCents": next.depositCents, "lowBalance": next.lowBalance,
                    "lowBalanceCents": next.lowBalanceCents, "budgets": next.budgets, "weekly": next.weekly,
                    "review": next.review, "connections": next.connections, "quietEnabled": next.quietEnabled,
                    "quietStartHour": next.quietStartHour, "quietEndHour": next.quietEndHour,
                ]
                prefs = try await api.patch("api/native/push/preferences", body: body)
                error = nil
            } catch {
                self.error = "Couldn't save that change."
                await load(using: api)
            }
        }
    }
}

#if os(iOS)
/// The one row in Settings. Everything else lives a tap deeper, like iOS's own Notifications settings.
struct NotificationsCard: View {
    @EnvironmentObject var api: API
    @ObservedObject private var push = PushManager.shared
    @StateObject private var store = PushPrefsStore()

    private var summary: String {
        guard push.isEnabled else { return "Off on this device" }
        guard let prefs = store.prefs else { return "On" }
        guard prefs.enabled else { return "Paused" }
        return "\(prefs.activeTypes) of 8 alert types"
    }

    var body: some View {
        NavigationLink {
            NotificationSettingsView(store: store)
        } label: {
            Card {
                HStack(spacing: 12) {
                    NotificationIcon(symbol: "bell.badge.fill", color: .red)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Notifications").font(.body.weight(.medium)).foregroundStyle(.primary)
                        Text(summary).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
            }
        }
        .buttonStyle(.plain)
        .task {
            await push.refreshPermission()
            await store.load(using: api)
        }
    }
}

/// Rounded-square symbol tile, as in iOS Settings.
struct NotificationIcon: View {
    let symbol: String
    let color: Color

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 30, height: 30)
            .background(color.gradient, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// Everything about notifications: a master switch, the alert types grouped by what they are about,
/// the amounts that trigger them, and quiet hours.
struct NotificationSettingsView: View {
    @ObservedObject var store: PushPrefsStore
    @EnvironmentObject var api: API
    @ObservedObject private var push = PushManager.shared
    @Environment(\.openURL) private var openURL
    @State private var testResult: String?
    @State private var sending = false

    private var prefs: PushPrefs { store.prefs ?? PushPrefs() }
    private var live: Bool { store.prefs != nil && prefs.enabled }

    var body: some View {
        List {
            deliverySection
            Group {
                moneySection
                spendingSection
                accountsSection
                quietSection
            }
            .disabled(!live)
            .opacity(live ? 1 : 0.45)
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .animation(.snappy(duration: 0.3), value: prefs)
        .sensoryFeedback(.selection, trigger: prefs)
        .task {
            await push.refreshPermission()
            await store.load(using: api)
        }
    }

    // MARK: Sections

    private var deliverySection: some View {
        Section {
            Toggle(isOn: bind(\.enabled)) {
                row("Allow Notifications", "Pause everything without losing your choices", "bell.badge.fill", .red)
            }
            if !push.isEnabled {
                if push.permission == .denied {
                    Button("Open iPhone Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                } else {
                    Button("Turn On for This iPhone") { Task { await push.enable() } }
                }
            } else {
                Button {
                    Task {
                        sending = true
                        testResult = await push.sendTest(using: api)
                        sending = false
                    }
                } label: {
                    HStack {
                        Text(sending ? "Sending…" : "Send a Test Notification")
                        if sending { Spacer(); ProgressView() }
                    }
                }
                .disabled(sending)
            }
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if let testResult { Text(testResult) }
                if let message = push.message { Text(message).foregroundStyle(.red) }
                if let error = store.error { Text(error).foregroundStyle(.red) }
                Text("Your Ledgr server decides what to send and delivers it through Apple's push service. These choices apply to every device on your account.")
            }
        }
    }

    private var moneySection: some View {
        Section("Money") {
            Toggle(isOn: bind(\.bills)) { row("Bills Due", "Today and tomorrow", "calendar", .red) }
            Toggle(isOn: bind(\.deposits)) { row("Deposits", "Paychecks and other money in", "arrow.down.circle.fill", .green) }
            if prefs.deposits {
                amount("Notify at or above", bind(\.depositCents), [10_000, 25_000, 50_000, 100_000, 250_000])
            }
            Toggle(isOn: bind(\.largeCharges)) { row("Large Charges", "A single big purchase", "creditcard.fill", .orange) }
            if prefs.largeCharges {
                amount("Notify at or above", bind(\.largeChargeCents), [5_000, 10_000, 25_000, 50_000, 100_000, 250_000])
            }
            Toggle(isOn: bind(\.lowBalance)) { row("Low Balance", "Checking or savings running low", "exclamationmark.triangle.fill", .yellow) }
            if prefs.lowBalance {
                amount("Notify when under", bind(\.lowBalanceCents), [2_500, 5_000, 10_000, 25_000, 50_000, 100_000])
            }
        }
    }

    private var spendingSection: some View {
        Section("Spending") {
            Toggle(isOn: bind(\.budgets)) { row("Budgets", "At 80% and when a category goes over", "chart.pie.fill", .blue) }
            Toggle(isOn: bind(\.weekly)) { row("Weekly Recap", "Sunday mornings", "chart.bar.fill", .indigo) }
            Toggle(isOn: bind(\.review)) { row("Needs a Category", "Once a day when 5 or more pile up", "tag.fill", .teal) }
        }
    }

    private var accountsSection: some View {
        Section("Accounts") {
            Toggle(isOn: bind(\.connections)) {
                row("Bank Connections", "When a bank needs you to sign in again", "building.columns.fill", .gray)
            }
        }
    }

    private var quietSection: some View {
        Section {
            Toggle(isOn: bind(\.quietEnabled)) { row("Quiet Hours", "Hold alerts overnight", "moon.fill", .purple) }
            if prefs.quietEnabled {
                Picker("From", selection: bind(\.quietStartHour)) { hours }
                Picker("Until", selection: bind(\.quietEndHour)) { hours }
            }
        } footer: {
            Text("Anything that comes up during quiet hours is sent at the first check after they end.")
        }
    }

    // MARK: Pieces

    private func row(_ title: String, _ detail: String, _ symbol: String, _ color: Color) -> some View {
        HStack(spacing: 12) {
            NotificationIcon(symbol: symbol, color: color)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                Text(detail).font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    private func amount(_ title: String, _ selection: Binding<Int>, _ base: [Int]) -> some View {
        Picker(title, selection: selection) {
            ForEach(Array(Set(base + [selection.wrappedValue])).sorted(), id: \.self) { cents in
                Text(cents.formatted(.currency(code: "USD").precision(.fractionLength(0)).scale(0.01))).tag(cents)
            }
        }
        .padding(.leading, 42) // lines up under the label, past the icon tile
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    private var hours: some View {
        ForEach(0..<24, id: \.self) { h in
            Text(Calendar.current.date(bySettingHour: h, minute: 0, second: 0, of: Date())?
                .formatted(.dateTime.hour()) ?? "\(h):00").tag(h)
        }
    }

    private func bind<V>(_ key: WritableKeyPath<PushPrefs, V>) -> Binding<V> {
        Binding(
            get: { prefs[keyPath: key] },
            set: { value in store.update({ $0[keyPath: key] = value }, using: api) }
        )
    }
}
#endif
