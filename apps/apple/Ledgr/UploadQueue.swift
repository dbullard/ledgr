import Foundation

struct QueuedReceipt: Codable, Identifiable, Equatable {
    var id: UUID
    var filename: String
    var createdAt: Date
}

/// Receipts waiting to upload. Files live on disk so a scan made with no
/// connection (or while signed out) is never lost; they upload as soon as the
/// server is reachable and a session exists.
@MainActor
final class UploadQueue: ObservableObject {
    @Published private(set) var items: [QueuedReceipt] = []
    @Published private(set) var uploading = false
    @Published var message: String?

    private let dir: URL
    private let indexURL: URL
    private let session: URLSession
    private let noRedirect = NoRedirectDelegate()

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LedgrQueue", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        dir = base
        indexURL = base.appendingPathComponent("index.json")
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 120
        session = URLSession(configuration: config, delegate: noRedirect, delegateQueue: nil)
        if let data = try? Data(contentsOf: indexURL),
           let saved = try? JSONDecoder().decode([QueuedReceipt].self, from: data) {
            items = saved.filter { FileManager.default.fileExists(atPath: fileURL($0).path) }
        }
    }

    private func fileURL(_ item: QueuedReceipt) -> URL {
        dir.appendingPathComponent(item.id.uuidString + "-" + item.filename)
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(items) { try? data.write(to: indexURL) }
    }

    func add(data: Data, filename: String) {
        let item = QueuedReceipt(id: UUID(), filename: Self.safe(filename), createdAt: Date())
        do {
            try data.write(to: fileURL(item))
            items.append(item)
            persist()
        } catch {
            message = "Couldn't save \(filename): \(error.localizedDescription)"
        }
    }

    /// Photos and files handed over by the system (picker, drag, Open In, share sheet).
    func addFile(at url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            message = "Couldn't read \(url.lastPathComponent)"
            return
        }
        let ext = url.pathExtension.lowercased()
        if ["heic", "heif"].contains(ext), let jpeg = ImageTools.jpegData(fromImageData: data) {
            add(data: jpeg, filename: url.deletingPathExtension().lastPathComponent + ".jpg")
        } else {
            add(data: data, filename: url.lastPathComponent)
        }
    }

    /// Files dropped into the shared App Group inbox by the share extension.
    func importSharedInbox() {
        guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.com.dbullard.ledgr") else { return }
        let inbox = root.appendingPathComponent("Inbox", isDirectory: true)
        guard let files = try? FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil) else { return }
        for url in files {
            // Names are "<8-char id>-<original name>"; show the original name.
            var name = url.lastPathComponent
            if name.count > 9, name[name.index(name.startIndex, offsetBy: 8)] == "-" { name = String(name.dropFirst(9)) }
            if let data = try? Data(contentsOf: url) {
                let ext = (name as NSString).pathExtension.lowercased()
                if ["heic", "heif"].contains(ext), let jpeg = ImageTools.jpegData(fromImageData: data) {
                    add(data: jpeg, filename: (name as NSString).deletingPathExtension + ".jpg")
                } else {
                    add(data: data, filename: name)
                }
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    func addImageData(_ data: Data, name: String = "photo") {
        let jpeg = ImageTools.jpegData(fromImageData: data) ?? data
        add(data: jpeg, filename: "\(name)-\(Self.stamp()).jpg")
    }

    func remove(_ item: QueuedReceipt) {
        try? FileManager.default.removeItem(at: fileURL(item))
        items.removeAll { $0.id == item.id }
        persist()
    }

    /// Uploads everything queued to `base` using the web view's session cookie.
    func flush(to base: URL, cookie: String?) async {
        guard !uploading, !items.isEmpty else { return }
        guard let cookie else {
            message = "Sign in to upload \(items.count) waiting receipt\(items.count == 1 ? "" : "s")."
            return
        }
        uploading = true
        defer { uploading = false }
        var attached = 0, waiting = 0, dupes = 0
        var failure: String?
        for item in items {
            switch await send(item, to: base, cookie: cookie) {
            case .attached: attached += 1; remove(item)
            case .waiting: waiting += 1; remove(item)
            case .duplicate: dupes += 1; remove(item)
            case .rejected(let why): failure = "\(item.filename): \(why)"; remove(item)
            case .needsLogin:
                message = "Sign in to upload \(items.count) waiting receipt\(items.count == 1 ? "" : "s")."
                return
            case .unreachable: return
            }
        }
        let parts = [
            attached > 0 ? "\(attached) attached automatically" : nil,
            waiting > 0 ? "\(waiting) waiting for a match" : nil,
            dupes > 0 ? "\(dupes) already uploaded" : nil,
        ].compactMap { $0 }
        if let failure { message = failure }
        else if !parts.isEmpty { message = parts.joined(separator: ", ") }
    }

    private enum Outcome { case attached, waiting, duplicate, rejected(String), needsLogin, unreachable }

    private func send(_ item: QueuedReceipt, to base: URL, cookie: String) async -> Outcome {
        guard let file = try? Data(contentsOf: fileURL(item)) else { return .rejected("file missing") }
        let boundary = "ledgr-" + UUID().uuidString
        var body = Data()
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(item.filename)\"\r\nContent-Type: \(Self.mime(item.filename))\r\n\r\n".data(using: .utf8)!)
        body.append(file)
        body.append("\r\n".data(using: .utf8)!)
        if let parsed = await ReceiptReader.parsedJSON(data: file, filename: item.filename) {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"parsed\"\r\n\r\n\(parsed)\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        var req = URLRequest(url: base.appendingPathComponent("api/receipts/upload"))
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.setValue(cookie, forHTTPHeaderField: "Cookie")
        do {
            let (data, response) = try await session.upload(for: req, from: body)
            guard let http = response as? HTTPURLResponse else { return .unreachable }
            if http.statusCode == 401 || (300..<400).contains(http.statusCode) { return .needsLogin }
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            if http.statusCode == 200 {
                switch json?["status"] as? String {
                case "attached": return .attached
                case "duplicate": return .duplicate
                default: return .waiting
                }
            }
            if http.statusCode == 400 { return .rejected(json?["error"] as? String ?? "rejected") }
            return .unreachable
        } catch {
            return .unreachable
        }
    }

    static func safe(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: "\"", with: "")
        return cleaned.isEmpty ? "receipt" : cleaned
    }

    static func stamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss"
        return f.string(from: Date())
    }

    static func mime(_ filename: String) -> String {
        switch (filename as NSString).pathExtension.lowercased() {
        case "pdf": return "application/pdf"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "heic": return "image/heic"
        case "txt": return "text/plain"
        case "eml": return "message/rfc822"
        default: return "application/octet-stream"
        }
    }
}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
