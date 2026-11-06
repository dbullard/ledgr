import Foundation
import PDFKit
#if os(iOS)
import UIKit
typealias PlatformImage = UIImage
#else
import AppKit
typealias PlatformImage = NSImage
#endif

enum ImageTools {
    /// Longest side kept when compressing, enough for OCR and well under the 15 MB limit.
    static let maxSide: CGFloat = 2400

    static func jpegData(from image: PlatformImage, quality: CGFloat = 0.75) -> Data? {
        #if os(iOS)
        let size = image.size
        let scale = min(1, maxSide / max(size.width, size.height))
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: target, format: {
            let f = UIGraphicsImageRendererFormat.default()
            f.scale = 1
            return f
        }())
        let resized = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
        return resized.jpegData(compressionQuality: quality)
        #else
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .jpeg, properties: [.compressionFactor: quality])
        #endif
    }

    /// Any image bytes (HEIC from Photos, PNG, ...) as JPEG, since the server reads JPEG reliably.
    static func jpegData(fromImageData data: Data) -> Data? {
        guard let image = PlatformImage(data: data) else { return nil }
        return jpegData(from: image)
    }

    #if os(iOS)
    /// One page becomes a JPEG; several become a single PDF so the receipt stays together.
    static func receiptFile(fromScans pages: [UIImage]) -> (data: Data, ext: String)? {
        if pages.count == 1, let data = jpegData(from: pages[0]) { return (data, "jpg") }
        let doc = PDFDocument()
        for (i, page) in pages.enumerated() {
            guard let jpeg = jpegData(from: page), let flat = UIImage(data: jpeg),
                  let pdfPage = PDFPage(image: flat) else { continue }
            doc.insert(pdfPage, at: i)
        }
        guard doc.pageCount > 0, let data = doc.dataRepresentation() else { return nil }
        return (data, "pdf")
    }
    #endif
}
