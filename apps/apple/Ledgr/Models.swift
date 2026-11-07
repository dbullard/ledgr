import Foundation
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct DashboardResponse: Codable {
    let summary: Summary
    let history: [NetPoint]
    let spending: [SpendRow]
    var recent: [Txn]
}

struct Summary: Codable {
    let netWorth: Int
    let assets: Int
    let liabilities: Int
    let monthlyIncome: Int
    let monthlyExpenses: Int
    let monthlyNet: Int
}

struct NetPoint: Codable, Identifiable {
    let date: String
    let netWorth: Int
    var id: String { date }
}

struct SpendRow: Codable, Identifiable {
    let categoryId: String?
    let categoryName: String
    let categoryIcon: String?
    let total: Int
    var id: String { categoryId ?? categoryName }
}

struct Txn: Codable, Identifiable, Hashable {
    let id: String
    let date: String
    let name: String
    let normalizedAmount: Int
    let pending: Bool
    var reviewed: Bool
    let accountName: String
    let merchantName: String?
    var categoryId: String?
    var categoryName: String?
    let categoryIcon: String?
    var notes: String?
    let hasSplits: Bool?
    let isTransfer: Bool
}

struct TxnPage: Codable {
    let rows: [Txn]
    let nextCursor: String?
}

struct SplitRow: Codable, Identifiable, Hashable {
    let id: String
    let categoryName: String?
    let amount: Int
    let notes: String?
}

struct ReceiptSummary: Codable, Identifiable, Hashable {
    let id: String
    let originalFilename: String
    let contentType: String
    let sizeBytes: Int
    let createdAt: String
}

/// One line read from a receipt on this transaction.
struct TxnItem: Codable, Identifiable, Hashable {
    let id: String
    let rawName: String
    let productName: String?
    let categoryName: String?
    let quantityMilli: Int
    let totalCents: Int
    var name: String { productName ?? rawName }
}

struct TxnDetail: Decodable {
    let txn: Txn
    let splits: [SplitRow]
    let receipts: [ReceiptSummary]
    let items: [TxnItem]
    /// Sum of the lines, and what's left of the charge after them (tax, fees, or a missed line).
    let itemsTotalCents: Int
    let itemsGapCents: Int?

    private enum Keys: String, CodingKey { case splits, receipts, items, itemsTotalCents, itemsGapCents }

    init(from decoder: Decoder) throws {
        txn = try Txn(from: decoder)
        let c = try decoder.container(keyedBy: Keys.self)
        splits = (try? c.decode([SplitRow].self, forKey: .splits)) ?? []
        receipts = (try? c.decode([ReceiptSummary].self, forKey: .receipts)) ?? []
        items = (try? c.decode([TxnItem].self, forKey: .items)) ?? []
        itemsTotalCents = (try? c.decode(Int.self, forKey: .itemsTotalCents)) ?? 0
        itemsGapCents = try? c.decodeIfPresent(Int.self, forKey: .itemsGapCents)
    }
}

struct Suggestion: Codable, Identifiable, Hashable {
    let transactionId: String
    let name: String
    let date: String
    let amountCents: Int
    let reasons: [String]
    var id: String { transactionId }
}

struct UnmatchedReceipt: Codable, Identifiable, Hashable {
    let id: String
    let originalFilename: String
    let contentType: String
    let sizeBytes: Int
    let createdAt: String
    let hintTotalCents: Int?
    let hintDate: String?
    let hintMerchant: String?
    let suggestions: [Suggestion]
}

struct CategoryGroup: Codable, Identifiable {
    let id: String
    let name: String
    let icon: String?
    let isSystem: Bool?
    let categories: [Category]
}

struct Category: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let icon: String?
    let isIncome: Bool
    let isSystem: Bool?
    let excludeFromSpending: Bool?
}

struct ItemsResponse: Codable {
    let from: String
    let to: String
    let byCategory: [ItemCategory]
    let products: [Product]
}

struct ItemCategory: Codable, Identifiable {
    let categoryId: String?
    let categoryName: String?
    let totalCents: Int
    let itemCount: Int
    var id: String { categoryId ?? "none" }
    var label: String { categoryName ?? "Uncategorized" }
}

struct Product: Codable, Identifiable {
    let key: String
    let name: String
    let totalCents: Int
    let purchases: Int
    let lastDate: String
    let avgUnitCents: Int
    /// Where it was bought, most often first. Absent from older servers.
    var stores: [ProductStore]? = nil
    var storeCount: Int? = nil
    var id: String { key }

    /// "Sam's Club · Walmart +1", or nil when the server didn't say.
    var storesSummary: String? {
        guard let stores, !stores.isEmpty else { return nil }
        let extra = (storeCount ?? stores.count) - stores.count
        return stores.map(\.name).joined(separator: " · ") + (extra > 0 ? " +\(extra)" : "")
    }
}

struct ProductStore: Codable, Hashable {
    let name: String
    let count: Int
}

// MARK: Formatting

enum Fmt {
    private static let currency: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        return f
    }()

    private static let whole: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = 0
        return f
    }()

    static func money(_ cents: Int) -> String {
        currency.string(from: NSNumber(value: Double(cents) / 100)) ?? "$0.00"
    }

    static func moneyWhole(_ cents: Int) -> String {
        whole.string(from: NSNumber(value: Double(cents) / 100)) ?? "$0"
    }

    private static let parser: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static let short: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()

    private static let long: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEEE, MMM d"
        return f
    }()

    static func iso(_ d: Date) -> String { parser.string(from: d) }

    static func date(_ iso: String) -> Date? { parser.date(from: String(iso.prefix(10))) }

    static func shortDate(_ iso: String) -> String {
        date(iso).map { short.string(from: $0) } ?? iso
    }

    static func dayHeader(_ iso: String) -> String {
        guard let d = date(iso) else { return iso }
        let cal = Calendar.current
        if cal.isDateInToday(d) { return "Today" }
        if cal.isDateInYesterday(d) { return "Yesterday" }
        return long.string(from: d)
    }

    /// 2000 -> "2", 1500 -> "1.5" (receipt quantities are stored in thousandths).
    static func quantity(_ milli: Int) -> String {
        let q = Double(milli) / 1000
        return q == q.rounded() ? String(Int(q)) : String(format: "%g", q)
    }

    static func bytes(_ n: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
    }
}

/// Category icons are Lucide names on the web; map the common ones to SF Symbols.
enum Icons {
    private static let map: [String: String] = [
        "dollar-sign": "dollarsign.circle", "banknote": "banknote", "laptop": "laptopcomputer",
        "trending-up": "chart.line.uptrend.xyaxis", "shopping-cart": "cart", "shopping-bag": "bag",
        "utensils": "fork.knife", "coffee": "cup.and.saucer", "car": "car", "fuel": "fuelpump",
        "home": "house", "house": "house", "zap": "bolt", "heart": "heart", "heart-pulse": "heart.text.square",
        "plane": "airplane", "film": "film", "music": "music.note", "gift": "gift", "baby": "figure.and.child.holdinghands",
        "shirt": "tshirt", "graduation-cap": "graduationcap", "wifi": "wifi", "phone": "phone",
        "pill": "pills", "dumbbell": "dumbbell", "paw-print": "pawprint", "wrench": "wrench.and.screwdriver",
        "landmark": "building.columns", "receipt": "receipt", "tv": "tv", "gamepad-2": "gamecontroller",
        "sparkles": "sparkles", "briefcase": "briefcase", "piggy-bank": "banknote", "repeat": "repeat",
        "arrow-left-right": "arrow.left.arrow.right", "tag": "tag", "tags": "tag",
        "bus": "bus", "bike": "bicycle", "ship": "ferry", "tent": "tent", "mountain": "mountain.2",
        "hammer": "hammer", "paintbrush": "paintbrush", "plug": "powerplug", "flame": "flame",
        "lightbulb": "lightbulb", "mail": "envelope", "credit-card": "creditcard", "wallet": "wallet.pass",
        "coins": "centsign.circle", "percent": "percent", "shield": "shield", "ticket": "ticket",
        "calendar": "calendar", "clock": "clock", "map-pin": "mappin", "globe": "globe", "camera": "camera",
        "headphones": "headphones", "hospital": "cross.case", "syringe": "syringe", "glasses": "eyeglasses",
        "bed": "bed.double", "sofa": "sofa", "trees": "tree", "recycle": "arrow.3.trianglepath",
        "truck": "truck.box", "package": "shippingbox", "building-2": "building.2", "school": "studentdesk",
        "dog": "dog", "cat": "cat", "cake": "birthday.cake", "gem": "diamond", "watch": "applewatch",
        "folder": "folder", "layers": "square.3.layers.3d", "key": "key", "user": "person",
        "smartphone": "iphone", "stethoscope": "stethoscope", "umbrella": "umbrella", "droplet": "drop",
        "book-open": "book", "scissors": "scissors", "guitar": "guitars", "beer": "mug", "wine": "wineglass",
        "scale": "scalemass", "church": "building.columns", "square-parking": "parkingsign",
        "train-front": "tram", "car-front": "car", "lamp": "lamp.desk", "cpu": "cpu",
        "hand-heart": "hand.raised", "pizza": "fork.knife", "sandwich": "fork.knife", "apple": "carrot",
        "popcorn": "film", "clapperboard": "film", "circle-dollar-sign": "dollarsign.circle",
        "dices": "dice", "flower-2": "leaf", "party-popper": "party.popper", "layers-2": "square.3.layers.3d",
    ]

    /// Names offered in the icon picker: every mapped icon whose SF Symbol exists on this OS,
    /// de-duplicated by symbol so each choice looks distinct.
    static let pickable: [String] = {
        var seen = Set<String>()
        return map.keys.sorted().filter { name in
            guard let sym = map[name], symbolExists(sym), !seen.contains(sym) else { return false }
            seen.insert(sym)
            return true
        }
    }()

    private static func symbolExists(_ name: String) -> Bool {
        #if canImport(UIKit)
        return UIImage(systemName: name) != nil
        #elseif canImport(AppKit)
        return NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil
        #else
        return true
        #endif
    }

    static func symbol(_ lucide: String?) -> String {
        guard let lucide else { return "questionmark.circle" }
        return map[lucide] ?? "tag"
    }
}

struct PricePoint: Codable, Identifiable {
    let date: String
    let merchant: String
    /// The charge this purchase came from. Absent from older servers.
    var transactionId: String? = nil
    var accountName: String? = nil
    let unitCents: Int
    let totalCents: Int
    let quantityMilli: Int
    var id: String { "\(date)|\(merchant)|\(totalCents)|\(quantityMilli)" }
}
