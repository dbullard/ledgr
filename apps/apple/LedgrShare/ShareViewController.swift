import Foundation
import UniformTypeIdentifiers

#if os(iOS)
import UIKit
typealias BaseController = UIViewController
#else
import AppKit
typealias BaseController = NSViewController
#endif

/// Share-sheet entry: copies whatever was shared (PDF, photo, file, email, text)
/// into the shared App Group inbox. The Ledgr app uploads it next time it is
/// open, using its own sign-in, so this extension never touches the network.
final class ShareViewController: BaseController {
    static let group = "group.com.dbullard.ledgr"
    private let label = ShareViewController.makeLabel()

    #if os(iOS)
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        run()
    }
    private static func makeLabel() -> UILabel {
        let l = UILabel(); l.text = "Saving to Ledgr…"; l.font = .preferredFont(forTextStyle: .headline); return l
    }
    private func set(_ text: String) { label.text = text }
    #else
    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 90))
        label.frame = NSRect(x: 0, y: 34, width: 320, height: 22)
        label.alignment = .center
        view.addSubview(label)
    }
    override func viewDidAppear() { super.viewDidAppear(); run() }
    private static func makeLabel() -> NSTextField {
        NSTextField(labelWithString: "Saving to Ledgr…")
    }
    private func set(_ text: String) { label.stringValue = text }
    #endif

    private func run() {
        Task {
            let saved = await save()
            set(saved > 0 ? "Saved to Ledgr. Open the app to upload." : "Nothing here Ledgr can use.")
            try? await Task.sleep(nanoseconds: 900_000_000)
            extensionContext?.completeRequest(returningItems: nil)
        }
    }

    private func inbox() -> URL? {
        guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.group) else { return nil }
        let dir = root.appendingPathComponent("Inbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func save() async -> Int {
        guard let inbox = inbox() else { return 0 }
        var count = 0
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        for provider in items.flatMap({ $0.attachments ?? [] }) {
            // Prefer a real file (keeps the original name and type); fall back to plain text.
            let fileTypes: [UTType] = [.pdf, .emailMessage, .image, .fileURL, .data]
            if let type = fileTypes.first(where: { provider.hasItemConformingToTypeIdentifier($0.identifier) }),
               let url = await copyFile(provider, type: type, into: inbox) {
                _ = url; count += 1
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                      let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String,
                      let data = text.data(using: .utf8) {
                let name = "shared-\(UUID().uuidString.prefix(8)).txt"
                if (try? data.write(to: inbox.appendingPathComponent(name))) != nil { count += 1 }
            }
        }
        return count
    }

    private func copyFile(_ provider: NSItemProvider, type: UTType, into dir: URL) async -> URL? {
        await withCheckedContinuation { cont in
            provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url else { cont.resume(returning: nil); return }
                let dest = dir.appendingPathComponent("\(UUID().uuidString.prefix(8))-\(url.lastPathComponent)")
                do { try FileManager.default.copyItem(at: url, to: dest); cont.resume(returning: dest) }
                catch { cont.resume(returning: nil) }
            }
        }
    }
}
