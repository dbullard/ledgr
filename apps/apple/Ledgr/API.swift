import Foundation
import WebKit

enum APIError: LocalizedError {
    case unauthorized, offline, server(String)

    var errorDescription: String? {
        switch self {
        case .unauthorized: return "Please sign in again."
        case .offline: return "Can't reach your server."
        case .server(let message): return message
        }
    }
}

/// Talks to Ledgr's /api/native endpoints with the same session cookie the web
/// app uses. The cookie lives in the web view's store, so signing in here also
/// signs in the "open in web" pages, and the other way round.
@MainActor
final class API: ObservableObject {
    enum AuthState { case unknown, signedOut, signedIn }

    @Published private(set) var auth: AuthState = .unknown
    /// Set whenever a transaction is edited so lists and the dashboard can update in place.
    @Published private(set) var changedTxn: Txn?
    /// Set by edits that touch several transactions at once.
    @Published private(set) var changedBatch: [Txn] = []
    /// Bumped on any edit that can change totals (category, review, receipts).
    @Published private(set) var dataVersion = 0

    private var bankSyncTask: Task<Void, Never>?
    private var lastBankSync: Date?

    /// Asks the server to pull new transactions from every connected bank. Pull-to-refresh
    /// calls this before it reloads. Overlapping pulls share one sync, a sync within the last
    /// 45 seconds is not repeated (so a pulling habit can't hammer the banks), and waiting
    /// stops after 40 seconds (the server keeps going). Never throws: a bank that can't
    /// sync just means the reload shows what is already there.
    func syncBanks() async {
        if let running = bankSyncTask { await running.value; return }
        if let last = lastBankSync, Date().timeIntervalSince(last) < 45 { return }
        let task = Task<Void, Never> {
            let work = Task { try? await self.post("api/native/accounts/sync", body: ["all": true]) }
            await withTaskGroup(of: Void.self) { group in
                group.addTask { _ = await work.value }
                group.addTask { try? await Task.sleep(nanoseconds: 40_000_000_000) }
                await group.next()
                group.cancelAll()
            }
        }
        bankSyncTask = task
        await task.value
        bankSyncTask = nil
        lastBankSync = Date()
    }

    func noteBulkChanged(_ txns: [Txn]) {
        changedBatch = txns
        dataVersion += 1
    }

    func noteChanged(_ txn: Txn? = nil) {
        if let txn { changedTxn = txn }
        dataVersion += 1
    }

    /// Why the last request was turned away, shown on the sign-in screen.
    @Published private(set) var lastIssue: String?

    /// Session cookies (name to value), kept in the Keychain.
    private var cookies: [String: String] = SessionStore.load()

    private let connection: Connection
    private let web: WebModel
    private let session: URLSession
    private let noRedirect = NoRedirect()

    init(connection: Connection, web: WebModel) {
        self.connection = connection
        self.web = web
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 30
        session = URLSession(configuration: config, delegate: noRedirect, delegateQueue: nil)
    }

    // MARK: Cookies

    /// Cookie header for requests to `url`: our own copy first, then whatever the web view holds.
    func cookieHeader(for url: URL) async -> String? {
        if !cookies.isEmpty {
            return cookies.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "; ")
        }
        return await web.cookieHeader(for: url)
    }

    /// Picks up cookies a response sets (sign-in, and the server refreshing the session).
    private func absorb(_ http: HTTPURLResponse, from url: URL) {
        let headers = http.allHeaderFields as? [String: String] ?? [:]
        var changed = false
        // Parse as if over https: Apple's parser drops Secure cookies that arrive over plain http,
        // but Ledgr sets them that way whenever its public address is https.
        var secureURL = URLComponents(url: url, resolvingAgainstBaseURL: false)
        secureURL?.scheme = "https"
        let parseURL = secureURL?.url ?? url
        for cookie in HTTPCookie.cookies(withResponseHeaderFields: headers, for: parseURL) where cookie.name.contains("better-auth") {
            if let exp = cookie.expiresDate, exp < Date() {
                if cookies.removeValue(forKey: cookie.name) != nil { changed = true }
            } else if cookies[cookie.name] != cookie.value {
                cookies[cookie.name] = cookie.value
                changed = true
            }
        }
        if changed { SessionStore.save(cookies) }
    }

    // MARK: Requests

    func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        let data = try await send("GET", path, query: query)
        return try decode(data)
    }

    func patch<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        let data = try await send("PATCH", path, body: body)
        return try decode(data)
    }

    func put(_ path: String, body: [String: Any]) async throws {
        _ = try await send("PUT", path, body: body)
    }

    func post(_ path: String, body: [String: Any]) async throws {
        _ = try await send("POST", path, body: body)
    }

    func delete(_ path: String, query: [String: String] = [:]) async throws {
        _ = try await send("DELETE", path, query: query)
    }

    /// Multipart upload for endpoints that take a file plus form fields. Returns the JSON object.
    func upload(_ path: String, fields: [String: String], file: Data, filename: String) async throws -> [String: Any] {
        guard let base = connection.active else { throw APIError.offline }
        let boundary = "ledgr-\(UUID().uuidString)"
        var body = Data()
        func add(_ s: String) { body.append(Data(s.utf8)) }
        for (k, v) in fields {
            add("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n")
        }
        add("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\nContent-Type: application/octet-stream\r\n\r\n")
        body.append(file)
        add("\r\n--\(boundary)--\r\n")
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if let cookie = await cookieHeader(for: base) { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await session.data(for: request) }
        catch { throw APIError.offline }
        guard let http = response as? HTTPURLResponse else { throw APIError.offline }
        if http.statusCode == 401 || (300..<400).contains(http.statusCode) { auth = .signedOut; throw APIError.unauthorized }
        absorb(http, from: base)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if !(200..<300).contains(http.statusCode) {
            throw APIError.server(json["error"] as? String ?? "The server returned an error (\(http.statusCode)).")
        }
        return json
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError.server("Unexpected response from the server.") }
    }

    private func send(_ method: String, _ path: String, query: [String: String] = [:], body: [String: Any]? = nil) async throws -> Data {
        guard let base = connection.active else { throw APIError.offline }
        var parts = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        if !query.isEmpty { parts?.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        guard let url = parts?.url else { throw APIError.offline }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let cookie = await cookieHeader(for: base) { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
        if let body {
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await session.data(for: request) }
        catch { throw APIError.offline }
        guard let http = response as? HTTPURLResponse else { throw APIError.offline }
        if http.statusCode == 401 || (300..<400).contains(http.statusCode) {
            if !cookies.isEmpty {
                lastIssue = "\(base.host ?? "The server") didn't accept the saved sign-in (code \(http.statusCode))."
                cookies = [:]
                SessionStore.clear()
            }
            auth = .signedOut
            throw APIError.unauthorized
        }
        absorb(http, from: base)
        if !(200..<300).contains(http.statusCode) {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw APIError.server(message ?? "The server returned an error (\(http.statusCode)).")
        }
        if auth != .signedIn { auth = .signedIn }
        return data
    }

    // MARK: Auth

    /// Finds out whether the stored session is still good.
    func refreshAuth() async {
        do {
            let _: [CategoryGroup] = try await get("api/native/categories")
            auth = .signedIn
        } catch APIError.unauthorized {
            auth = .signedOut
        } catch {
            // Offline: keep what we know; the connection banner explains.
            if auth == .unknown, connection.mode == .offline { return }
        }
    }

    func signIn(email: String, password: String) async throws {
        guard let base = connection.active else { throw APIError.offline }
        var request = URLRequest(url: base.appendingPathComponent("api/auth/sign-in/email"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(Self.origin(base), forHTTPHeaderField: "Origin")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["email": email, "password": password])
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await session.data(for: request) }
        catch { throw APIError.offline }
        guard let http = response as? HTTPURLResponse else { throw APIError.offline }
        guard http.statusCode == 200 else {
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw APIError.server(json?["message"] as? String ?? "Couldn't sign in. Check your email and password.")
        }
        absorb(http, from: base)
        guard cookies.keys.contains(where: { $0.contains("session_token") }) else {
            throw APIError.server("The server signed you in but sent no session. Try the other address in Server settings.")
        }
        // Verify the session before declaring success, so a rejected one is explained here.
        do {
            let _: [CategoryGroup] = try await get("api/native/categories")
        } catch APIError.unauthorized {
            throw APIError.server("Signed in, but \(base.host ?? "the server") rejected the session (code check failed).")
        }
        lastIssue = nil
        await mirrorToWebView(base: base)
        auth = .signedIn
    }

    /// Best effort: also hand the session to the web view so the "Full app" pages are signed in.
    /// Secure cookies are stripped to plain ones on http addresses, which would otherwise be refused.
    private func mirrorToWebView(base: URL) async {
        let store = WKWebsiteDataStore.default().httpCookieStore
        for url in [connection.homeURL, connection.awayURL].compactMap({ $0 }) {
            guard let host = url.host else { continue }
            let secure = url.scheme == "https"
            for (name, value) in cookies {
                var props: [HTTPCookiePropertyKey: Any] = [.name: name, .value: value, .domain: host, .path: "/"]
                props[.expires] = Date().addingTimeInterval(7 * 86_400)
                if secure { props[.secure] = "TRUE" }
                if let cookie = HTTPCookie(properties: props) { await store.setCookie(cookie) }
            }
        }
        auth = .signedIn
    }

    func signOut() async {
        await PushManager.shared.unregister(using: self)
        if let base = connection.active {
            var request = URLRequest(url: base.appendingPathComponent("api/auth/sign-out"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(Self.origin(base), forHTTPHeaderField: "Origin")
            request.httpBody = Data("{}".utf8)
            if let cookie = await cookieHeader(for: base) { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
            _ = try? await session.data(for: request)
        }
        cookies = [:]
        SessionStore.clear()
        let store = WKWebsiteDataStore.default().httpCookieStore
        for cookie in await store.allCookies() where cookie.name.contains("better-auth") {
            await store.deleteCookie(cookie)
        }
        auth = .signedOut
    }

    static func origin(_ url: URL) -> String {
        var s = "\(url.scheme ?? "http")://\(url.host ?? "")"
        if let port = url.port { s += ":\(port)" }
        return s
    }

    /// Downloads a stored receipt to a temp file so it can be previewed.
    func downloadReceipt(_ receipt: ReceiptSummary) async throws -> URL {
        guard let base = connection.active else { throw APIError.offline }
        var request = URLRequest(url: base.appendingPathComponent("api/receipts/\(receipt.id)"))
        if let cookie = await cookieHeader(for: base) { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await session.data(for: request) }
        catch { throw APIError.offline }
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw APIError.server("Couldn't open that receipt.")
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("receipts", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(receipt.id + "-" + UploadQueue.safe(receipt.originalFilename))
        try data.write(to: url)
        return url
    }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
