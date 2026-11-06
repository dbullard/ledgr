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

    // MARK: Requests

    func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        let data = try await send("GET", path, query: query)
        return try decode(data)
    }

    func patch<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        let data = try await send("PATCH", path, body: body)
        return try decode(data)
    }

    func post(_ path: String, body: [String: Any]) async throws {
        _ = try await send("POST", path, body: body)
    }

    func delete(_ path: String) async throws {
        _ = try await send("DELETE", path)
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
        if let cookie = await web.cookieHeader(for: base) { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
        if let body {
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await session.data(for: request) }
        catch { throw APIError.offline }
        guard let http = response as? HTTPURLResponse else { throw APIError.offline }
        if http.statusCode == 401 || (300..<400).contains(http.statusCode) {
            auth = .signedOut
            throw APIError.unauthorized
        }
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
        let headers = http.allHeaderFields as? [String: String] ?? [:]
        let store = WKWebsiteDataStore.default().httpCookieStore
        for cookie in HTTPCookie.cookies(withResponseHeaderFields: headers, for: base) {
            await store.setCookie(cookie)
        }
        await CookieSync.sync(between: [connection.homeURL, connection.awayURL].compactMap { $0 })
        auth = .signedIn
    }

    func signOut() async {
        if let base = connection.active {
            var request = URLRequest(url: base.appendingPathComponent("api/auth/sign-out"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(Self.origin(base), forHTTPHeaderField: "Origin")
            request.httpBody = Data("{}".utf8)
            if let cookie = await web.cookieHeader(for: base) { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
            _ = try? await session.data(for: request)
        }
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
        if let cookie = await web.cookieHeader(for: base) { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
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
