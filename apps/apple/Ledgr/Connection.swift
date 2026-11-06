import Foundation
import Network
import WebKit

enum ConnectionMode: String {
    case checking, home, away, offline

    var label: String {
        switch self {
        case .checking: return "Connecting…"
        case .home: return "Home"
        case .away: return "Away"
        case .offline: return "Offline"
        }
    }

    var symbol: String {
        switch self {
        case .checking: return "arrow.triangle.2.circlepath"
        case .home: return "house.fill"
        case .away: return "lock.shield.fill"
        case .offline: return "wifi.slash"
        }
    }
}

/// Picks the home (LAN) or away (VPN / proxy) address, like Home Assistant's
/// internal/external URLs: the home address is tried first with a short timeout,
/// then the away one. Re-checked whenever the network changes.
@MainActor
final class Connection: ObservableObject {
    @Published var homeText: String {
        didSet { UserDefaults.standard.set(homeText, forKey: "homeURL") }
    }
    @Published var awayText: String {
        didSet { UserDefaults.standard.set(awayText, forKey: "awayURL") }
    }
    /// False until the first-run screen's Connect button is pressed, so the form
    /// doesn't vanish while the address is still being typed.
    @Published var setupComplete: Bool {
        didSet { UserDefaults.standard.set(setupComplete, forKey: "setupComplete") }
    }
    @Published private(set) var active: URL?
    @Published private(set) var mode: ConnectionMode = .checking

    private let monitor = NWPathMonitor()
    private var refreshTask: Task<Void, Never>?
    private var started = false

    init() {
        homeText = UserDefaults.standard.string(forKey: "homeURL") ?? ""
        awayText = UserDefaults.standard.string(forKey: "awayURL") ?? ""
        setupComplete = UserDefaults.standard.bool(forKey: "setupComplete")
        if let last = UserDefaults.standard.string(forKey: "lastActiveURL") {
            active = URL(string: last)
        }
    }

    var homeURL: URL? { Self.normalize(homeText) }
    var awayURL: URL? { Self.normalize(awayText) }
    var isConfigured: Bool { homeURL != nil || awayURL != nil }

    /// Hosts the web view may stay on; anything else opens in the system browser.
    var allowedHosts: Set<String> {
        Set([homeURL, awayURL].compactMap { $0?.host?.lowercased() })
    }

    static func normalize(_ text: String) -> URL? {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        if !t.contains("://") { t = "http://" + t }
        while t.hasSuffix("/") { t.removeLast() }
        guard let url = URL(string: t), url.host != nil else { return nil }
        return url
    }

    func start() {
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { [weak self] _ in
            Task { @MainActor in self?.scheduleRefresh() }
        }
        monitor.start(queue: DispatchQueue(label: "ledgr.path"))
        scheduleRefresh()
    }

    /// Debounced: networks flap several times while switching Wi-Fi/VPN.
    func scheduleRefresh(after delay: Duration = .milliseconds(600)) {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }

    func refresh() async {
        guard isConfigured else {
            mode = .checking
            return
        }
        if active == nil || mode == .offline { mode = .checking }
        var chosen: (ConnectionMode, URL)?
        if let home = homeURL, await Self.probe(home, timeout: 1.5) {
            chosen = (.home, home)
        } else if let away = awayURL, await Self.probe(away, timeout: 6) {
            chosen = (.away, away)
        }
        guard let (newMode, url) = chosen else {
            mode = .offline
            return
        }
        await CookieSync.sync(between: [homeURL, awayURL].compactMap { $0 })
        mode = newMode
        if active != url {
            active = url
            UserDefaults.standard.set(url.absoluteString, forKey: "lastActiveURL")
        }
    }

    nonisolated static func probe(_ base: URL, timeout: TimeInterval) async -> Bool {
        var request = URLRequest(url: base.appendingPathComponent("api/health"))
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }
        do {
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            return json?["status"] as? String == "ok"
        } catch {
            return false
        }
    }
}

/// The session cookie belongs to one host, so signing in at home would not carry
/// over to the VPN address. Copy it to the other address (newest wins) so one
/// sign-in works on both.
enum CookieSync {
    @MainActor
    static func sync(between urls: [URL]) async {
        let hosts = urls.compactMap { $0.host?.lowercased() }
        guard Set(hosts).count > 1 else { return }
        let store = WKWebsiteDataStore.default().httpCookieStore
        let all = await store.allCookies()
        let ours = all.filter { $0.name.contains("better-auth") }
        for url in urls {
            guard let host = url.host?.lowercased() else { continue }
            let secure = url.scheme == "https"
            let existing = ours.filter { Self.matches($0, host: host) }
            for cookie in ours where !Self.matches(cookie, host: host) {
                if cookie.name.hasPrefix("__Secure-") && !secure { continue }
                if let have = existing.first(where: { $0.name == cookie.name }),
                   (have.expiresDate ?? .distantPast) >= (cookie.expiresDate ?? .distantPast) {
                    continue
                }
                var props: [HTTPCookiePropertyKey: Any] = [
                    .name: cookie.name,
                    .value: cookie.value,
                    .domain: host,
                    .path: "/",
                ]
                if let exp = cookie.expiresDate { props[.expires] = exp }
                if secure { props[.secure] = "TRUE" }
                if let copy = HTTPCookie(properties: props) {
                    await store.setCookie(copy)
                }
            }
        }
    }

    private static func matches(_ cookie: HTTPCookie, host: String) -> Bool {
        cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased() == host
    }
}
