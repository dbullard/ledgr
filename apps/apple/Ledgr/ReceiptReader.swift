import Foundation
import CoreGraphics
import ImageIO
import PDFKit
import Vision
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Reads a receipt on the device before it is uploaded (iOS 27 / macOS 27):
/// Vision pulls the text, then Apple's on-device model, which can also see the
/// picture, turns it into merchant, date, total and line items. Nothing is
/// sent anywhere; the result rides along with the upload so the server can
/// match the receipt and store its items. Every failure falls back to the
/// server's own reading, so this is strictly an upgrade.
enum ReceiptReader {
    /// JSON the server accepts in the `parsed` upload field, or nil when this
    /// device can't read receipts (older OS, no Apple Intelligence, not a receipt).
    static func parsedJSON(data: Data, filename: String) async -> String? {
        #if canImport(FoundationModels)
        if #available(iOS 27.0, macOS 27.0, *) {
            guard let parsed = await read(data: data, filename: filename) else { return nil }
            guard let json = try? JSONEncoder().encode(parsed) else { return nil }
            return String(data: json, encoding: .utf8)
        }
        #endif
        return nil
    }

    /// One short sentence saying what a document is ("Reimbursement from Acme for March
    /// conference travel"), for receipts with no itemized lines. nil when this device
    /// can't read documents or the file has no readable text.
    static func noteText(data: Data, filename: String, context: String) async -> String? {
        #if canImport(FoundationModels)
        if #available(iOS 27.0, macOS 27.0, *) {
            return await writeNote(data: data, filename: filename, context: context)
        }
        #endif
        return nil
    }

    /// Model output cleaned for a notes field: one line, no wrapping quotes, bounded length.
    static func cleanedNote(_ raw: String) -> String? {
        var t = raw.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        t = t.trimmingCharacters(in: CharacterSet(charactersIn: "\"“”'` "))
        while t.contains("  ") { t = t.replacingOccurrences(of: "  ", with: " ") }
        guard t.count >= 4 else { return nil }
        return t.count > 160 ? String(t.prefix(157)) + "…" : t
    }

    static func pages(data: Data, filename: String) -> [CGImage] {
        if filename.lowercased().hasSuffix(".pdf") {
            guard let doc = PDFDocument(data: data) else { return [] }
            return (0..<min(doc.pageCount, 2)).compactMap { i in
                guard let page = doc.page(at: i) else { return nil }
                let box = page.bounds(for: .mediaBox)
                let scale = min(2.5, 2000 / max(box.width, box.height))
                let size = CGSize(width: box.width * scale, height: box.height * scale)
                guard let ctx = CGContext(data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8,
                                          bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
                ctx.setFillColor(CGColor(gray: 1, alpha: 1))
                ctx.fill(CGRect(origin: .zero, size: size))
                ctx.scaleBy(x: scale, y: scale)
                page.draw(with: .mediaBox, to: ctx)
                return ctx.makeImage()
            }
        }
        let ext = (filename as NSString).pathExtension.lowercased()
        guard ["jpg", "jpeg", "png", "heic", "heif", "webp"].contains(ext),
              let src = CGImageSourceCreateWithData(data as CFData, nil) else { return [] }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                     kCGImageSourceCreateThumbnailWithTransform: true,
                                     kCGImageSourceThumbnailMaxPixelSize: 2000]
        return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary).map { [$0] } ?? []
    }

    private static func cents(in line: String) -> [Int] {
        guard let rx = try? NSRegularExpression(pattern: #"(?<![\d.])(\d{1,6})[.,](\d{2})(?!\d)"#) else { return [] }
        let ns = line as NSString
        return rx.matches(in: line, range: NSRange(location: 0, length: ns.length)).compactMap { m in
            Int(ns.substring(with: m.range(at: 1)) + ns.substring(with: m.range(at: 2)))
        }
    }

    /// Small models sometimes misread a digit even with the text in front of them.
    /// Trust the recognized text over the model: re-take each price from the printed
    /// line, drop items whose price never appears, and forget a total that isn't printed.
    static func verified(_ r: ParsedReceiptPayload, ocr: String) -> ParsedReceiptPayload {
        let lines = ocr.components(separatedBy: "\n")
        let printed = Set(lines.flatMap { cents(in: $0) })
        var out = r
        out.items = r.items.compactMap { item in
            var it = item
            let words = item.name.uppercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).prefix(2).joined(separator: " ")
            if !words.isEmpty,
               let line = lines.first(where: { $0.uppercased().replacingOccurrences(of: "-", with: " ").contains(words) }),
               let price = cents(in: line).last {
                it.totalCents = price
                return it
            }
            return printed.contains(it.totalCents) ? it : nil
        }
        if let t = out.totalCents, !printed.contains(t) { out.totalCents = nil }
        if let t = out.taxCents, !printed.contains(t) { out.taxCents = nil }
        return out
    }

    /// Text lines, top to bottom, from Apple's text recognizer.
    static func recognizeText(_ image: CGImage) -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        try? VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }
}

struct ParsedReceiptPayload: Codable {
    struct Item: Codable { var name: String; var quantity: Double?; var totalCents: Int }
    var merchant: String?
    var date: String?
    var totalCents: Int?
    var taxCents: Int?
    var items: [Item]
}

#if canImport(FoundationModels)
@available(iOS 27.0, macOS 27.0, *)
@Generable
struct ScannedItem {
    @Guide(description: "The product as printed, lightly cleaned up")
    var name: String
    @Guide(description: "Price for this line in US cents, e.g. 799 for $7.99")
    var totalCents: Int
}

@available(iOS 27.0, macOS 27.0, *)
@Generable
struct ScannedReceipt {
    @Guide(description: "Store or business name")
    var merchant: String?
    @Guide(description: "Purchase date as YYYY-MM-DD")
    var date: String?
    @Guide(description: "Final amount charged including tax, in cents")
    var totalCents: Int?
    @Guide(description: "Sales tax in cents, if shown")
    var taxCents: Int?
    @Guide(description: "Purchased items only; skip subtotal, tax, total, payment and change lines")
    var items: [ScannedItem]
}

@available(iOS 27.0, macOS 27.0, *)
@Generable
struct DocumentNote {
    @Guide(description: "One plain sentence, under 100 characters, saying what this document is and who or what it is for. Use only what is printed.")
    var note: String
}

@available(iOS 27.0, macOS 27.0, *)
extension ReceiptReader {
    static func writeNote(data: Data, filename: String, context: String) async -> String? {
        let model = SystemLanguageModel.default
        guard case .available = model.availability else { return nil }
        let images = await Task.detached { pages(data: data, filename: filename) }.value
        guard let first = images.first else { return nil }
        let text = images.map { recognizeText($0) }.joined(separator: "\n")
        guard text.count > 20 else { return nil }
        do {
            return try await withThrowingTaskGroup(of: String?.self) { group in
                group.addTask {
                    let session = LanguageModelSession(
                        model: model,
                        instructions: "You write one short note for a personal finance app about a document attached to a bank transaction. Say what it is (a reimbursement, refund, invoice, statement, order confirmation, letter...) and who or what it is for, using only what is printed. One sentence. Never guess or invent details."
                    )
                    let response: LanguageModelSession.Response<DocumentNote>
                    if model.capabilities.contains(.vision) {
                        response = try await session.respond(generating: DocumentNote.self) {
                            "Transaction: \(context)\nRecognized text, top to bottom:\n\(text.prefix(4000))"
                            Attachment(first)
                        }
                    } else {
                        response = try await session.respond(generating: DocumentNote.self) {
                            "Transaction: \(context)\nRecognized text, top to bottom:\n\(text.prefix(4000))"
                        }
                    }
                    return cleanedNote(response.content.note)
                }
                group.addTask { try await Task.sleep(nanoseconds: 30_000_000_000); return nil }
                defer { group.cancelAll() }
                return try await group.next() ?? nil
            }
        } catch {
            return nil
        }
    }

    static func read(data: Data, filename: String) async -> ParsedReceiptPayload? {
        let model = SystemLanguageModel.default
        guard case .available = model.availability, model.capabilities.contains(.vision) else { return nil }
        let images = await Task.detached { pages(data: data, filename: filename) }.value
        guard let first = images.first else { return nil }
        let text = images.map { recognizeText($0) }.joined(separator: "\n--- next page ---\n")
        guard text.count > 20 else { return nil }   // blank, or not a document

        do {
            return try await withThrowingTaskGroup(of: ParsedReceiptPayload?.self) { group in
                group.addTask {
                    let session = LanguageModelSession(
                        model: model,
                        instructions: "You read store receipts. Use the photo and the recognized text together. Prices are US dollars; report them as integer cents. Never invent items or amounts that aren't printed."
                    )
                    let response = try await session.respond(generating: ScannedReceipt.self) {
                        "Read this receipt. Recognized text, top to bottom:\n\(text.prefix(6000))"
                        Attachment(first)
                    }
                    let r = response.content
                    let items = r.items.filter { !$0.name.trimmingCharacters(in: .whitespaces).isEmpty && $0.totalCents > 0 }
                    if r.totalCents == nil && items.isEmpty { return nil }
                    let raw = ParsedReceiptPayload(
                        merchant: r.merchant, date: r.date, totalCents: r.totalCents, taxCents: r.taxCents,
                        items: items.map { .init(name: $0.name, quantity: nil, totalCents: $0.totalCents) })
                    return ReceiptReader.verified(raw, ocr: text)
                }
                group.addTask { try await Task.sleep(nanoseconds: 60_000_000_000); return nil }
                defer { group.cancelAll() }
                return try await group.next() ?? nil
            }
        } catch {
            return nil
        }
    }
}
#endif
