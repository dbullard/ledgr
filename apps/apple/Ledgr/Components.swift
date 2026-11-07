import SwiftUI
import Charts

extension Color {
    /// Palette adapted from the Copilot Money Mac app's design tokens
    /// (pale blue-grey canvas + white cards in light, deep navy in dark).
    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        func rgb(_ v: UInt32) -> (Double, Double, Double) {
            (Double((v >> 16) & 0xFF) / 255, Double((v >> 8) & 0xFF) / 255, Double(v & 0xFF) / 255)
        }
        #if os(iOS)
        return Color(UIColor { t in
            let c = rgb(t.userInterfaceStyle == .dark ? dark : light)
            return UIColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
        })
        #else
        return Color(NSColor(name: nil) { a in
            let isDark = a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let c = rgb(isDark ? dark : light)
            return NSColor(srgbRed: c.0, green: c.1, blue: c.2, alpha: 1)
        })
        #endif
    }

    static let card = dynamic(light: 0xFFFFFF, dark: 0x03101C)
    static let canvas = dynamic(light: 0xF6F8FA, dark: 0x00080F)
    static let hairline = dynamic(light: 0xE4E8EF, dark: 0x0C2340)
    static let track = dynamic(light: 0xDDE1E8, dark: 0x042554)
    static let income = dynamic(light: 0x1AA80F, dark: 0x31D252)
    static let alert = dynamic(light: 0xD96800, dark: 0xFF7A00)
}

struct Card<Content: View>: View {
    var title: String?
    var trailing: AnyView?
    @ViewBuilder var content: Content

    init(_ title: String? = nil, trailing: AnyView? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.trailing = trailing
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if title != nil || trailing != nil {
                HStack {
                    if let title {
                        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    trailing
                }
            }
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.hairline, lineWidth: 1))
        .shadow(color: .black.opacity(0.04), radius: 8, y: 2)
    }
}

struct ErrorState: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        ContentUnavailableView {
            Label("Couldn't load", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            if let retry { Button("Try again", action: retry).buttonStyle(.borderedProminent) }
        }
    }
}

/// User-chosen category colours by category id, shared so every badge in the app can look one up.
@MainActor @Observable
final class CategoryStyles {
    static let shared = CategoryStyles()
    private(set) var colors: [String: String] = [:]

    func update(_ groups: [CategoryGroup]) {
        colors = groups.flatMap(\.categories).reduce(into: [:]) { out, c in if let hex = c.color { out[c.id] = hex } }
    }

    func set(_ categoryId: String, _ hex: String?) { colors[categoryId] = hex }

    func refresh(_ api: API) async {
        if let groups: [CategoryGroup] = try? await api.get("api/native/categories") { update(groups) }
    }
}

struct CategoryBadge: View {
    let icon: String?
    var size: CGFloat = 38
    /// Looks up the category's chosen colour; nil keeps the automatic one.
    var categoryId: String?
    /// Explicit "#RRGGBB" (the picker's live preview); wins over the lookup.
    var colorHex: String?

    private static let palette: [Color] = [
        Color(red: 0.01, green: 0.39, blue: 0.77), Color(red: 0.13, green: 0.65, blue: 0.38),
        Color(red: 0.85, green: 0.41, blue: 0.0), Color(red: 0.55, green: 0.32, blue: 0.85),
        Color(red: 0.86, green: 0.25, blue: 0.40), Color(red: 0.0, green: 0.60, blue: 0.70),
        Color(red: 0.69, green: 0.50, blue: 0.0),
    ]
    private var tint: Color {
        if let hex = colorHex ?? categoryId.flatMap({ CategoryStyles.shared.colors[$0] }), let custom = Color(hex: hex) { return custom }
        guard let icon else { return .gray }
        return Self.palette[abs(icon.unicodeScalars.reduce(0) { $0 &* 31 &+ Int($1.value) }) % Self.palette.count]
    }

    var body: some View {
        Image(systemName: Icons.symbol(icon))
            .font(.system(size: size * 0.44, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(tint.opacity(0.14), in: Circle())
    }
}

/// The merchant's logo when we have one, otherwise the category badge.
/// Logos arrive either as an https URL (Plaid) or a base64 `data:` URI
/// (favicon cached by the server), so both are handled.
struct MerchantAvatar: View {
    let txn: Txn
    var size: CGFloat = 38

    private static let cache = NSCache<NSString, PlatformImage>()

    private static func decoded(_ dataURI: String) -> PlatformImage? {
        if let hit = cache.object(forKey: dataURI as NSString) { return hit }
        guard let comma = dataURI.firstIndex(of: ","),
              let data = Data(base64Encoded: String(dataURI[dataURI.index(after: comma)...])),
              let image = PlatformImage(data: data) else { return nil }
        cache.setObject(image, forKey: dataURI as NSString)
        return image
    }

    private var fallback: some View {
        CategoryBadge(icon: txn.isTransfer ? "arrow-left-right" : txn.categoryIcon, size: size, categoryId: txn.isTransfer ? nil : txn.categoryId)
    }

    private func logo(_ image: Image) -> some View {
        image
            .resizable()
            .scaledToFit()
            .padding(size * 0.16)
            .frame(width: size, height: size)
            .background(Color.white, in: Circle())
            .clipShape(Circle())
    }

    var body: some View {
        if txn.isTransfer {
            fallback
        } else if let raw = txn.merchantLogoUrl, !raw.isEmpty {
            if raw.hasPrefix("data:") {
                if let image = Self.decoded(raw) { logo(Image(platformImage: image)) } else { fallback }
            } else if let url = URL(string: raw) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image { logo(image) } else { fallback }
                }
            } else {
                fallback
            }
        } else {
            fallback
        }
    }
}

// `PlatformImage` (NSImage / UIImage) is declared in ImageTools.swift.
#if os(iOS)
extension Image { init(platformImage: PlatformImage) { self.init(uiImage: platformImage) } }
#else
extension Image { init(platformImage: PlatformImage) { self.init(nsImage: platformImage) } }
#endif

struct TxnRow: View {
    let txn: Txn
    /// On-device suggestion shown (with a sparkle) until the user confirms it.
    var suggestion: Category?

    var body: some View {
        HStack(spacing: 12) {
            MerchantAvatar(txn: txn)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if !txn.reviewed && !txn.isTransfer {
                        Circle().fill(Color.accentColor).frame(width: 7, height: 7)
                    }
                    Text(txn.name).font(.body.weight(.medium)).lineLimit(1)
                }
                HStack(spacing: 4) {
                    if txn.isTransfer {
                        // Transfers aren't categorized, so never flag them as missing one.
                        Label("Transfer", systemImage: "arrow.left.arrow.right").lineLimit(1).fixedSize()
                    } else if let cat = txn.categoryName {
                        Text(cat).lineLimit(1).fixedSize()
                    } else if let s = suggestion {
                        Label(s.name, systemImage: "sparkles").foregroundStyle(Color.accentColor).lineLimit(1).fixedSize()
                    } else {
                        Text("Uncategorized").foregroundStyle(Color.alert).lineLimit(1).fixedSize()
                    }
                    Text("· \(txn.accountName)").lineLimit(1).truncationMode(.tail)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(Fmt.money(txn.normalizedAmount))
                    .font(.body.monospacedDigit())
                    .fontWeight(.medium)
                    .foregroundStyle(txn.normalizedAmount > 0 ? Color.income : Color.primary)
                if txn.pending { Text("Pending").font(.caption2).foregroundStyle(.secondary) }
            }
        }
        .contentShape(Rectangle())
    }
}

/// Y range zoomed to the data (with padding) so trends are visible instead of being flattened against $0.
func tightDomain(_ values: [Double]) -> ClosedRange<Double> {
    let lo = values.min() ?? 0, hi = values.max() ?? 1
    let pad = max((hi - lo) * 0.12, abs(hi) * 0.01, 1)
    return (lo - pad)...(hi + pad)
}

extension View {
    func tightYScale(_ values: [Double]) -> some View { chartYScale(domain: tightDomain(values)) }
}

extension Color {
    /// "#RRGGBB" (the "#" is optional).
    init?(hex: String) {
        var h = hex.trimmingCharacters(in: .whitespaces)
        if h.hasPrefix("#") { h.removeFirst() }
        guard h.count == 6, let v = UInt32(h, radix: 16) else { return nil }
        self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }

    var hexString: String {
        let c = resolve(in: EnvironmentValues())
        func byte(_ f: Float) -> Int { Int((min(max(f, 0), 1) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", byte(c.red), byte(c.green), byte(c.blue))
    }
}
