import Foundation

struct DashboardResponse: Codable {
    let summary: Summary
    let history: [NetPoint]
    let spending: [SpendRow]
    let recent: [Txn]
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

struct TxnDetail: Decodable {
    let txn: Txn
    let splits: [SplitRow]
    let receipts: [ReceiptSummary]

    private enum Keys: String, CodingKey { case splits, receipts }

    init(from decoder: Decoder) throws {
        txn = try Txn(from: decoder)
        let c = try decoder.container(keyedBy: Keys.self)
        splits = (try? c.decode([SplitRow].self, forKey: .splits)) ?? []
        receipts = (try? c.decode([ReceiptSummary].self, forKey: .receipts)) ?? []
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
    var id: String { key }
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
    ]

    static func symbol(_ lucide: String?) -> String {
        guard let lucide else { return "questionmark.circle" }
        return map[lucide] ?? "tag"
    }
}
