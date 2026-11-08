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
    /// The bank's own description, kept so a rename can be undone.
    let originalName: String?
    /// Set when the user renamed this transaction; syncs keep it.
    let customName: String?
    /// Plaid logo URL, or a cached favicon as a `data:` URI. Absent for merchants with no logo.
    let merchantLogoUrl: String?
    var categoryId: String?
    var categoryName: String?
    let categoryIcon: String?
    var notes: String?
    let hasSplits: Bool?
    let isTransfer: Bool
    /// The recurring item this transaction belongs to, if any.
    let recurringTransactionId: String?

    /// What lists show: the user's own name, else the resolved merchant, else the bank's (often noisy) description.
    var displayName: String {
        if let c = customName, !c.isEmpty { return c }
        if let m = merchantName, !m.isEmpty { return m }
        return name
    }
}

struct TxnPage: Codable {
    let rows: [Txn]
    let nextCursor: String?
    /// True number of matches, only when the request asked for it (`count=1`).
    var count: Int? = nil
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
    /// "#RRGGBB" for the group; categories without their own colour inherit it.
    let color: String?
    let isSystem: Bool?
    let categories: [Category]
}

extension Array where Element == CategoryGroup {
    /// Groups A–Z, and each group's categories A–Z (natural, case-insensitive).
    var alphabetical: [CategoryGroup] {
        map { g in
            CategoryGroup(id: g.id, name: g.name, icon: g.icon, color: g.color, isSystem: g.isSystem,
                          categories: g.categories.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending })
        }
        .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
}

struct Category: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let icon: String?
    /// "#RRGGBB" the user picked; nil means the automatic colour.
    let color: String?
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
    private static let base: [String: String] = [
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
        // Home & appliances
        "bath": "bathtub", "shower-head": "shower", "washing-machine": "washer", "refrigerator": "refrigerator",
        "microwave": "microwave", "monitor": "desktopcomputer", "printer": "printer", "keyboard": "keyboard",
        "mouse": "computermouse", "speaker": "hifispeaker", "fan": "fan", "air-vent": "air.conditioner.horizontal",
        "door-open": "door.left.hand.open", "armchair": "chair.lounge", "lock": "lock", "tool-case": "toolbox",
        "paint-roller": "paintbrush.pointed", "shovel": "shovel", "trash-2": "trash", "archive": "archivebox",
        // Nature, weather, animals
        "sun": "sun.max", "moon": "moon", "cloud": "cloud", "snowflake": "snowflake", "wind": "wind",
        "thermometer": "thermometer.medium", "leaf": "leaf", "fish": "fish", "bird": "bird", "rabbit": "hare",
        "turtle": "tortoise", "bug": "ant", "waves": "water.waves", "sunrise": "sunrise",
        // People & health
        "users": "person.2", "user-plus": "person.badge.plus", "footprints": "figure.walk",
        "person-standing": "figure.stand", "accessibility": "figure.roll", "brain": "brain",
        "eye": "eye", "ear": "ear", "bandage": "cross.case", "activity": "waveform.path.ecg",
        "bone": "figure.arms.open", "tooth": "mouth", "smile": "face.smiling", "baby-bottle": "waterbottle",
        // Food & drink
        "cookie": "birthday.cake", "ice-cream-cone": "takeoutbag.and.cup.and.straw", "soup": "takeoutbag.and.cup.and.straw",
        "cup-soda": "cup.and.saucer", "martini": "wineglass", "carrot": "carrot", "croissant": "fork.knife",
        "store": "storefront", "shopping-basket": "basket", "egg": "oval", "salad": "leaf.circle",
        // Travel & transport
        "bus-front": "bus", "car-taxi-front": "car", "motorbike": "scooter", "rocket": "airplane.departure",
        "map": "map", "compass": "safari", "navigation": "location", "luggage": "suitcase", "hotel": "building.2",
        "sailboat": "sailboat", "fuel-pump": "fuelpump", "ev-charger": "bolt.car", "parking": "parkingsign",
        // Money & work
        "badge-dollar-sign": "dollarsign.square", "hand-coins": "banknote", "receipt-text": "doc.text",
        "calculator": "plus.forwardslash.minus", "chart-pie": "chart.pie", "chart-bar": "chart.bar",
        "file-text": "doc.text", "clipboard": "list.clipboard", "paperclip": "paperclip", "stamp": "seal",
        "building": "building", "factory": "building.2.crop.circle", "landmark-2": "building.columns",
        // Fun & misc
        "star": "star", "bell": "bell", "bookmark": "bookmark", "flag": "flag", "trophy": "trophy",
        "medal": "medal", "palette": "paintpalette", "brush": "paintbrush", "pen": "pencil", "newspaper": "newspaper",
        "podcast": "mic", "mic": "mic", "radio": "radio", "video": "video", "image": "photo", "ticket-percent": "ticket",
        "bomb": "burst", "skull": "exclamationmark.triangle", "circle-help": "questionmark.circle", "infinity": "infinity",
        "puzzle": "puzzlepiece", "wand-sparkles": "wand.and.stars", "crown": "crown", "anchor": "water.waves",
    ]

    private static let map: [String: String] = base.merging(extra) { a, _ in a }

    /// More icons, grouped by theme. Names follow Lucide where one exists so the web app can draw them too.
    private static let extra: [String: String] = [
        // Beauty & personal care
        "lipstick": "mouth", "sparkle": "sparkle", "comb": "comb", "spray-can": "bubbles.and.sparkles",
        "hand-sparkles": "hands.sparkles", "bubbles": "bubbles.and.sparkles", "toilet": "toilet", "sink": "sink",
        "bath-tub": "bathtub", "flower": "camera.macro", "razor": "scissors", "sun-medium": "sun.min", "heart-circle": "heart.circle",
        // Faith & giving
        "church": "cross", "cross": "cross.fill", "star-and-crescent": "star.and.crescent", "moon-star": "moon.stars",
        "hands-clapping": "hands.clap", "hand-helping": "hand.raised", "handshake": "hands.sparkles", "gift-card": "giftcard",
        "candle": "flame.circle", "book-heart": "books.vertical",
        // Clothing & accessories
        "hanger": "hanger", "handbag": "handbag", "sunglasses": "sunglasses", "ring": "circle.circle", "backpack": "backpack",
        "footprints-shoe": "shoeprints.fill", "socks": "figure.stand.dress", "umbrella-closed": "umbrella.fill",
        // Kids & family
        "teddy-bear": "teddybear", "stroller": "stroller", "toy-brick": "cube", "school-bag": "backpack.fill",
        "ruler": "ruler", "pencil-ruler": "pencil.and.ruler", "abc": "abc", "book-closed": "book.closed",
        "crayon": "pencil.tip", "family": "figure.2.and.child.holdinghands", "couple": "person.2.fill",
        // Pets & animals
        "bird-flying": "bird.fill", "ladybug": "ladybug", "dog-bone": "pawprint.fill", "fish-bowl": "fish.fill",
        "hare": "hare.fill", "tortoise": "tortoise.fill", "horse": "figure.equestrian.sports", "cow": "tortoise.circle",
        // Sports & fitness
        "run": "figure.run", "yoga": "figure.yoga", "golf": "figure.golf", "tennis": "figure.tennis",
        "basketball": "basketball", "soccer": "soccerball", "football": "football", "baseball": "baseball",
        "volleyball": "volleyball", "swim": "figure.pool.swim", "hiking": "figure.hiking", "ski": "figure.skiing.downhill",
        "bowling": "figure.bowling", "climbing": "figure.climbing", "boxing": "figure.boxing", "surf": "figure.surfing",
        "sports-court": "sportscourt", "trophy-star": "trophy.fill", "stopwatch": "stopwatch", "timer": "timer",
        "dumbbell-heavy": "figure.strengthtraining.traditional", "skateboard": "skateboard", "target": "target",
        // Entertainment & hobbies
        "drama": "theatermasks", "piano": "pianokeys", "mic-vocal": "music.mic", "play": "play.rectangle",
        "books": "books.vertical", "palette-brush": "paintpalette.fill", "camera-lens": "camera.aperture",
        "binoculars": "binoculars", "telescope": "scope", "cards": "suit.spade", "chess": "checkerboard.rectangle",
        "puzzle-piece": "puzzlepiece.fill", "magic-wand": "wand.and.rays", "balloon": "balloon", "confetti": "party.popper.fill",
        "disc": "opticaldisc", "vinyl": "record.circle", "radio-tower": "antenna.radiowaves.left.and.right",
        // Tech & subscriptions
        "tablet": "ipad", "monitor-smartphone": "display", "hard-drive": "externaldrive", "server": "server.rack",
        "cloud-upload": "icloud", "network": "network", "qr-code": "qrcode", "fax": "faxmachine", "scanner": "scanner",
        "airpods": "airpodspro", "smart-speaker": "homepod", "watch-smart": "applewatch.watchface", "tv-play": "play.tv",
        "app-window": "app.badge", "code": "chevron.left.forwardslash.chevron.right", "terminal": "terminal",
        "bluetooth": "dot.radiowaves.left.and.right", "satellite-dish": "dot.radiowaves.forward", "battery": "battery.100",
        // Home & garden
        "screwdriver": "screwdriver", "fan-blades": "fanblades", "garage": "door.garage.closed", "oven": "oven",
        "stove": "cooktop", "dishwasher": "dishwasher", "dryer": "dryer", "lamp-floor": "lamp.floor", "chair": "chair",
        "bed-single": "bed.double.fill", "hose": "spigot", "water-tap": "spigot.fill", "solar-panel": "sun.max.fill",
        "thermostat": "thermometer.sun", "smoke": "smoke", "fire-extinguisher": "flame.fill", "mailbox": "mail.stack",
        "paint-bucket": "paintbrush.fill", "ladder": "figure.stairs", "plant": "leaf.fill", "tree-deciduous": "tree.fill",
        // Food & drink
        "coffee-bean": "cup.and.saucer.fill", "takeout": "takeoutbag.and.cup.and.straw.fill", "bottle": "waterbottle.fill",
        "bakery": "birthday.cake.fill", "grill": "flame.circle.fill", "fork": "fork.knife.circle", "tea": "mug.fill",
        "cocktail": "wineglass.fill", "grocery": "basket.fill", "storefront-2": "storefront.fill", "apple-fruit": "carrot.fill",
        // Health & medical
        "lungs": "lungs", "tooth-clean": "mouth.fill", "allergens": "allergens", "cross-vial": "cross.vial",
        "thermometer-med": "medical.thermometer", "star-of-life": "staroflife", "pill-bottle": "pills.fill",
        "heart-pulse-2": "heart.circle.fill", "wheelchair": "figure.roll", "mask": "facemask", "dna": "atom",
        "ear-hearing": "ear.fill", "eye-care": "eye.fill", "microscope": "testtube.2", "test-tube": "testtube.2",
        // Money & documents
        "bitcoin": "bitcoinsign.circle", "euro": "eurosign.circle", "pound-sterling": "sterlingsign.circle",
        "japanese-yen": "yensign.circle", "refresh-cash": "dollarsign.arrow.circlepath", "signature": "signature",
        "seal": "seal", "file-check": "doc.text.fill", "folder-open": "folder.fill", "mail-stack": "tray.full",
        "inbox": "tray", "id-card": "person.text.rectangle", "passport": "person.crop.rectangle", "gavel": "hammer.fill",
        "shield-check": "checkmark.shield", "lock-keyhole": "lock.fill", "key-round": "key.fill", "piggy": "banknote.fill",
        // Travel & places
        "beach": "beach.umbrella", "palm-tree": "tree", "map-trifold": "map.fill", "signpost": "signpost.right",
        "road": "road.lanes", "plane-takeoff": "airplane.departure", "plane-landing": "airplane.arrival",
        "train": "train.side.front.car", "sailing": "sailboat.fill", "tram-front": "tram.fill", "camping": "tent.fill",
        "earth": "globe.americas", "compass-rose": "location.north", "backpacking": "figure.walk.motion", "hotel-bed": "bed.double",
        "castle": "building.columns.fill", "stadium": "sportscourt.fill", "museum": "building.columns.circle",
        "hospital-building": "building.2.crop.circle.fill", "library": "books.vertical.fill", "fountain": "drop.circle",
    ]

    /// Extra words each icon answers to in the picker's search ("makeup" finds the lips icon, "tithe" the church).
    private static let keywords: [String: [String]] = [
        "church": ["faith", "religion", "worship", "chapel", "tithe", "offering", "mass", "temple"],
        "cross": ["faith", "religion", "christian", "medical"],
        "lipstick": ["makeup", "cosmetics", "beauty", "lips", "salon"],
        "sparkle": ["beauty", "clean", "new"], "sparkles": ["beauty", "clean", "magic"],
        "comb": ["hair", "haircut", "barber", "salon"], "scissors": ["hair", "haircut", "barber", "salon", "craft"],
        "spray-can": ["cleaning", "perfume", "hairspray", "beauty"], "hand-sparkles": ["cleaning", "sanitizer", "spa"],
        "bath": ["spa", "bathroom"], "bath-tub": ["spa", "bathroom"], "shower-head": ["bathroom"],
        "toilet": ["bathroom", "plumbing"], "washing-machine": ["laundry", "laundromat"], "dryer": ["laundry"],
        "hanger": ["clothes", "clothing", "dry cleaning"], "shirt": ["clothes", "clothing", "apparel"],
        "handbag": ["purse", "fashion"], "sunglasses": ["fashion", "eyewear"], "glasses": ["eyewear", "vision", "optometrist"],
        "hand-heart": ["charity", "donation", "giving", "nonprofit"], "gift": ["present", "birthday", "holiday"],
        "baby": ["kids", "child", "daycare", "diapers"], "teddy-bear": ["kids", "toys", "baby"],
        "school": ["tuition", "education", "college"], "graduation-cap": ["tuition", "school", "college", "education"],
        "dog": ["pet", "vet", "groomer"], "cat": ["pet", "vet"], "paw-print": ["pet", "vet", "animal"],
        "fish": ["pet", "seafood", "aquarium"], "dumbbell": ["gym", "fitness", "workout"], "run": ["gym", "fitness", "jogging"],
        "yoga": ["gym", "fitness", "wellness"], "golf": ["sports", "club"], "tennis": ["sports", "club"],
        "basketball": ["sports"], "soccer": ["sports"], "football": ["sports"], "baseball": ["sports"],
        "drama": ["theater", "theatre", "concert", "show", "tickets"], "ticket": ["event", "concert", "movie"],
        "film": ["movies", "cinema", "streaming"], "tv": ["streaming", "cable", "subscription"],
        "music": ["spotify", "streaming", "concert"], "guitar": ["music", "lessons", "instrument"],
        "gamepad-2": ["gaming", "video games", "xbox", "playstation"], "dices": ["games", "gambling", "casino"],
        "camera": ["photo", "photography"], "book-open": ["books", "reading", "library", "kindle"],
        "wifi": ["internet", "isp", "router"], "phone": ["mobile", "cell", "carrier"], "smartphone": ["mobile", "cell", "carrier"],
        "zap": ["electric", "power", "utilities"], "flame": ["gas", "heating", "propane"], "droplet": ["water", "sewer", "utilities"],
        "trash-2": ["garbage", "waste", "utilities"], "recycle": ["garbage", "waste", "recycling"],
        "wrench": ["repairs", "maintenance", "mechanic"], "hammer": ["repairs", "diy", "contractor", "home improvement"],
        "car": ["auto", "vehicle", "payment"], "fuel": ["gas", "gasoline", "petrol"], "fuel-pump": ["gas", "gasoline"],
        "square-parking": ["parking", "garage", "meter"], "bus": ["transit", "commute"], "train-front": ["transit", "commute", "rail"],
        "plane": ["flights", "airfare", "travel"], "luggage": ["travel", "trip", "vacation"], "hotel": ["lodging", "travel", "airbnb"],
        "pill": ["pharmacy", "medication", "prescription", "drugs"], "pills": ["pharmacy", "medication"], "stethoscope": ["doctor", "medical", "physician"],
        "hospital": ["medical", "er", "clinic"], "syringe": ["vaccine", "medical", "shots"], "heart-pulse": ["health", "cardio", "medical"],
        "tooth-clean": ["dentist", "dental"], "mask": ["medical", "health"], "eye-care": ["vision", "optometrist"],
        "landmark": ["bank", "government", "irs", "taxes"], "banknote": ["cash", "income", "paycheck"], "coins": ["change", "savings"],
        "piggy-bank": ["savings", "save"], "credit-card": ["card", "fees", "interest"], "percent": ["interest", "tax", "fees"],
        "receipt": ["bill", "invoice", "tax"], "briefcase": ["work", "business", "job"], "laptop": ["work", "freelance", "computer"],
        "bitcoin": ["crypto"], "gavel": ["legal", "attorney", "court", "fees"], "shield": ["insurance", "protection"],
        "shield-check": ["insurance", "protection", "security"], "umbrella": ["insurance", "rain"],
        "utensils": ["restaurant", "dining", "food"], "coffee": ["cafe", "coffee shop", "starbucks"], "pizza": ["restaurant", "takeout"],
        "beer": ["bar", "alcohol", "brewery"], "wine": ["bar", "alcohol", "liquor"], "cocktail": ["bar", "alcohol", "drinks"],
        "shopping-cart": ["groceries", "supermarket", "store"], "shopping-bag": ["retail", "clothing", "shopping"],
        "store": ["shop", "retail", "market"], "package": ["shipping", "delivery", "amazon"], "truck": ["shipping", "delivery", "moving"],
        "home": ["rent", "mortgage", "house"], "house": ["rent", "mortgage", "home"], "key": ["rent", "lock", "locksmith"],
        "sofa": ["furniture", "living room"], "bed": ["furniture", "mattress", "bedroom"], "lamp": ["furniture", "decor"],
        "tent": ["camping", "outdoors"], "mountain": ["hiking", "outdoors", "ski"], "beach": ["vacation", "travel", "pool"],
        "calendar": ["subscription", "annual", "dues"], "mail": ["postage", "usps", "post office"], "printer": ["office", "supplies", "printing"],
        "cloud-upload": ["storage", "icloud", "subscription", "software"], "code": ["software", "dev", "subscription"],
    ]

    /// Picker icons matching `query` by name or by a related word.
    static func search(_ query: String) -> [String] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return pickable }
        let dashed = q.replacingOccurrences(of: " ", with: "-")
        return pickable.filter { name in
            name.contains(dashed) || (keywords[name] ?? []).contains { $0.contains(q) }
        }
    }

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
