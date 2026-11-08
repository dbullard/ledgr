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
        // The group's colour applies to every category in it (icons stay per category).
        // Excluded categories are the exception: they share the colour set on the "Excluded" section,
        // which is saved on each of them, and fall back to their group's colour.
        colors = groups.reduce(into: [:]) { out, g in
            for c in g.categories {
                let hex = c.excludeFromSpending == true ? (c.color ?? g.color) : (g.color ?? c.color)
                if let hex { out[c.id] = hex }
            }
        }
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
    private var tint: Color { Self.tint(icon: icon, categoryId: categoryId, colorHex: colorHex) }

    /// The badge colour for a category: the user's choice if any, else a stable colour from the icon name.
    static func tint(icon: String?, categoryId: String?, colorHex: String? = nil) -> Color {
        if let hex = colorHex ?? categoryId.flatMap({ CategoryStyles.shared.colors[$0] }), let custom = Color(hex: hex) { return custom }
        guard let icon else { return .gray }
        return palette[abs(icon.unicodeScalars.reduce(0) { $0 &* 31 &+ Int($1.value) }) % palette.count]
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

/// Instant press feedback for the category pill: dims and settles back as the pointer lifts.
struct PillPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.6 : 1)
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.snappy(duration: 0.12), value: configuration.isPressed)
    }
}

struct TxnRow: View {
    let txn: Txn
    /// On-device suggestion shown (with a sparkle) until the user confirms it.
    var suggestion: Category?
    /// With these, the category pill opens a quick picker that calls `onCategory`.
    var groups: [CategoryGroup] = []
    var onCategory: ((String?) -> Void)?
    /// One dense line per transaction (Mac list): name and account, then the category pill, amount and review dot in columns.
    var compact = false
    @State private var showPicker = false
    @State private var hovering = false

    private var interactive: Bool { onCategory != nil && !txn.isTransfer }

    /// Only spending is marked recurring; income never gets the repeat icon.
    private var isRecurringExpense: Bool { txn.recurringTransactionId != nil && txn.normalizedAmount < 0 }

    private var incomeOnly: Bool {
        if let id = txn.categoryId, let cat = groups.lazy.flatMap(\.categories).first(where: { $0.id == id }) { return cat.isIncome }
        return txn.normalizedAmount > 0
    }

    var body: some View {
        if compact { compactBody } else { regularBody }
    }

    private var compactBody: some View {
        HStack(spacing: 10) {
            CategoryBadge(icon: txn.isTransfer ? "arrow-left-right" : txn.categoryIcon, size: 26, categoryId: txn.isTransfer ? nil : txn.categoryId)
            HStack(spacing: 8) {
                Text(txn.displayName).font(.body).lineLimit(1).layoutPriority(1)
                if isRecurringExpense {
                    Image(systemName: "repeat").font(.caption.weight(.semibold)).foregroundStyle(Color.accentColor).help("Recurring").accessibilityLabel("Recurring")
                }
                // The account trails the name and is the first thing to truncate.
                Text(txn.accountName).font(.callout).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
            }
            Spacer(minLength: 12)
            categoryPill.frame(width: 176, alignment: .trailing)
            HStack(spacing: 6) {
                if txn.pending { Image(systemName: "clock").font(.caption).foregroundStyle(.secondary).help("Pending") }
                Text(Fmt.money(txn.normalizedAmount))
                    .font(.body.monospacedDigit())
                    .fontWeight(.medium)
                    .foregroundStyle(txn.normalizedAmount > 0 ? Color.income : Color.primary)
            }
            .frame(width: 112, alignment: .trailing)
            // Blue dot = not reviewed yet; the column stays reserved so amounts line up.
            Circle().fill(!txn.reviewed && !txn.isTransfer ? Color.accentColor : Color.clear).frame(width: 7, height: 7)
        }
        .padding(.vertical, 1)
        .contentShape(Rectangle())
    }

    private var regularBody: some View {
        HStack(spacing: 12) {
            // The category's icon leads the list; the merchant logo is on the detail page.
            CategoryBadge(icon: txn.isTransfer ? "arrow-left-right" : txn.categoryIcon, categoryId: txn.isTransfer ? nil : txn.categoryId)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    if !txn.reviewed && !txn.isTransfer {
                        Circle().fill(Color.accentColor).frame(width: 7, height: 7)
                    }
                    Text(txn.displayName).font(.body.weight(.medium)).lineLimit(1)
                    if isRecurringExpense {
                        Image(systemName: "repeat").font(.caption.weight(.semibold)).foregroundStyle(Color.accentColor).accessibilityLabel("Recurring")
                    }
                }
                HStack(spacing: 6) {
                    categoryPill
                    Text(txn.accountName).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                }
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

    @ViewBuilder private var categoryPill: some View {
        if txn.isTransfer {
            pill("Transfer", systemImage: "arrow.left.arrow.right", tint: .secondary, chevron: false)
        } else if interactive {
            Button { showPicker = true } label: { pillContent }
                .buttonStyle(PillPressStyle())
                // A larger hit area than the pill draws, without taking more room in the row.
                .padding(.vertical, 6).contentShape(Rectangle()).padding(.vertical, -6)
                .onHover { hovering = $0 }
                .accessibilityLabel("Category: \(txn.categoryName ?? "none"). Change category")
                .sensoryFeedback(.selection, trigger: txn.categoryId)
                .popover(isPresented: $showPicker, arrowEdge: .bottom) {
                    CategoryPicker(groups: groups, incomeOnly: incomeOnly, currentId: txn.categoryId, loading: groups.isEmpty) { id in
                        showPicker = false
                        onCategory?(id)
                    }
                }
        } else {
            pillContent
        }
    }

    @ViewBuilder private var pillContent: some View {
        if let cat = txn.categoryName {
            pill(cat, systemImage: compact ? Icons.symbol(txn.categoryIcon) : nil, tint: CategoryBadge.tint(icon: txn.categoryIcon, categoryId: txn.categoryId), chevron: interactive)
        } else if let s = suggestion {
            pill(s.name, systemImage: "sparkles", tint: .accentColor, chevron: interactive)
        } else {
            pill("Uncategorized", tint: Color.alert, chevron: interactive)
        }
    }

    private func pill(_ text: String, systemImage: String? = nil, tint: Color, chevron: Bool) -> some View {
        HStack(spacing: 4) {
            if let systemImage { Image(systemName: systemImage).font(.caption2.weight(.semibold)).imageScale(.small) }
            Text(text).lineLimit(1)
            // The chevron appears on hover (Mac); the pill shape alone signals "tappable" elsewhere.
            #if os(macOS)
            if chevron && hovering { Image(systemName: "chevron.down").font(.caption2.weight(.bold)).imageScale(.small).opacity(0.8) }
            #endif
        }
        .font(.caption.weight(.medium))
        // Text is nudged toward the primary label colour so tinted pills stay readable on dark backgrounds.
        .foregroundStyle(tint.mix(with: .primary, by: 0.35))
        .padding(.horizontal, 8).padding(.vertical, 3)
        .background(tint.opacity(chevron && hovering ? 0.26 : 0.16), in: Capsule())
        .contentTransition(.opacity)
        .animation(.snappy(duration: 0.2), value: text)
        .animation(.snappy(duration: 0.15), value: hovering)
        .fixedSize()
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
