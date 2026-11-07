import SwiftUI
import UniformTypeIdentifiers

/// Turns dropped items (files from Finder/Files, images from Photos or a browser, PDFs) into
/// receipt-ready data. HEIC is converted to JPEG so the server and parser accept it.
@MainActor
enum ReceiptDrop {
    static let types: [UTType] = [.fileURL, .image, .pdf]

    struct File { let data: Data; let name: String }

    static func load(_ providers: [NSItemProvider]) async -> [File] {
        var out: [File] = []
        for p in providers {
            if let f = await fromFileURL(p) { out.append(f) }
            else if let f = await fromData(p) { out.append(f) }
        }
        return out
    }

    private static func fromFileURL(_ p: NSItemProvider) async -> File? {
        guard p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) else { return nil }
        let url: URL? = await withCheckedContinuation { cont in
            _ = p.loadObject(ofClass: URL.self) { url, _ in cont.resume(returning: url) }
        }
        guard let url, url.isFileURL else { return nil }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return nil }
        let ext = url.pathExtension.lowercased()
        if ["heic", "heif"].contains(ext), let jpeg = ImageTools.jpegData(fromImageData: data) {
            return File(data: jpeg, name: url.deletingPathExtension().lastPathComponent + ".jpg")
        }
        return File(data: data, name: url.lastPathComponent)
    }

    private static func fromData(_ p: NSItemProvider) async -> File? {
        let base = p.suggestedName ?? "dropped-\(UploadQueue.stamp())"
        for type in [UTType.pdf, UTType.image] where p.hasItemConformingToTypeIdentifier(type.identifier) {
            let data: Data? = await withCheckedContinuation { cont in
                p.loadDataRepresentation(forTypeIdentifier: type.identifier) { d, _ in cont.resume(returning: d) }
            }
            guard let data else { continue }
            if type == .pdf { return File(data: data, name: (base as NSString).deletingPathExtension + ".pdf") }
            return File(data: ImageTools.jpegData(fromImageData: data) ?? data, name: (base as NSString).deletingPathExtension + ".jpg")
        }
        return nil
    }
}

extension API {
    /// Uploads straight onto one transaction (no matching step).
    func attachReceipt(to transactionId: String, data: Data, filename: String) async throws {
        var fields: [String: String] = [:]
        if let parsed = await ReceiptReader.parsedJSON(data: data, filename: filename) { fields["parsed"] = parsed }
        _ = try await upload("api/native/transactions/\(transactionId)/receipts", fields: fields, file: data, filename: filename)
        await fillNoteIfNeeded(transactionId: transactionId, data: data, filename: filename)
    }

    /// A receipt with no itemized lines (a reimbursement letter, an invoice) says little about
    /// the charge, so the on-device model writes a one-line note, but only when the transaction
    /// has no note of its own. Never throws: a missing note is the worst case.
    func fillNoteIfNeeded(transactionId: String, data: Data, filename: String) async {
        guard let detail: TxnDetail = try? await get("api/native/transactions/\(transactionId)"),
              detail.items.isEmpty,
              (detail.txn.notes ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let t = detail.txn
        let context = "\(t.merchantName ?? t.name), \(Fmt.money(abs(t.normalizedAmount))) \(t.normalizedAmount >= 0 ? "received" : "paid") on \(t.date)"
        guard let note = await ReceiptReader.noteText(data: data, filename: filename, context: context) else { return }
        // Re-check right before writing: a note typed while the model was thinking wins.
        guard let latest: TxnDetail = try? await get("api/native/transactions/\(transactionId)"),
              (latest.txn.notes ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let _: Txn? = try? await patch("api/native/transactions/\(transactionId)", body: ["notes": note])
    }
}

/// Highlights a drop target and attaches dropped receipts to a specific transaction.
struct TransactionDropTarget: ViewModifier {
    let transactionId: String
    var inset: CGFloat = 0
    var onResult: (String) -> Void
    @EnvironmentObject var api: API
    @State private var targeted = false
    /// Files being read and uploaded (the server reads the receipt before it answers).
    @State private var working = 0

    func body(content: Content) -> some View {
        content
            .onDrop(of: ReceiptDrop.types, isTargeted: $targeted) { providers in
                Task {
                    working += providers.count
                    defer { working = max(0, working - providers.count) }
                    let files = await ReceiptDrop.load(providers)
                    guard !files.isEmpty else { onResult("Couldn't read that file"); return }
                    var done = 0
                    for f in files {
                        do { try await api.attachReceipt(to: transactionId, data: f.data, filename: f.name); done += 1 }
                        catch APIError.unauthorized { return }
                        catch { onResult(error.localizedDescription); return }
                    }
                    onResult(done == 1 ? "Receipt attached" : "\(done) receipts attached")
                }
                return true
            }
            .overlay {
                if targeted {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                        .background(Color.accentColor.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .padding(-inset)
                        .overlay { Label("Drop to attach", systemImage: "paperclip").font(.subheadline.weight(.semibold)).foregroundStyle(Color.accentColor) }
                        .allowsHitTesting(false)
                }
            }
            .overlay {
                if working > 0 {
                    // A small card in the middle, not a veil over the whole screen.
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text(working == 1 ? "Reading receipt…" : "Reading \(working) receipts…").font(.subheadline.weight(.medium))
                    }
                    .padding(.horizontal, 18).padding(.vertical, 12)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.primary.opacity(0.08)))
                    .shadow(color: .black.opacity(0.25), radius: 14, y: 4)
                    .transition(.scale(scale: 0.92).combined(with: .opacity))
                    .allowsHitTesting(false)
                }
            }
            .animation(.snappy(duration: 0.15), value: targeted)
            .animation(.snappy(duration: 0.2), value: working)
    }
}

extension View {
    func receiptDropTarget(transactionId: String, inset: CGFloat = 0, onResult: @escaping (String) -> Void) -> some View {
        modifier(TransactionDropTarget(transactionId: transactionId, inset: inset, onResult: onResult))
    }
}
