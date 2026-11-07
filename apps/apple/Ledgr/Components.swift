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

struct CategoryBadge: View {
    let icon: String?
    var size: CGFloat = 38

    private static let palette: [Color] = [
        Color(red: 0.01, green: 0.39, blue: 0.77), Color(red: 0.13, green: 0.65, blue: 0.38),
        Color(red: 0.85, green: 0.41, blue: 0.0), Color(red: 0.55, green: 0.32, blue: 0.85),
        Color(red: 0.86, green: 0.25, blue: 0.40), Color(red: 0.0, green: 0.60, blue: 0.70),
        Color(red: 0.69, green: 0.50, blue: 0.0),
    ]
    private var tint: Color {
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

struct TxnRow: View {
    let txn: Txn
    /// On-device suggestion shown (with a sparkle) until the user confirms it.
    var suggestion: Category?

    var body: some View {
        HStack(spacing: 12) {
            CategoryBadge(icon: txn.isTransfer ? "arrow-left-right" : txn.categoryIcon)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if !txn.reviewed && !txn.isTransfer {
                        Circle().fill(Color.accentColor).frame(width: 7, height: 7)
                    }
                    Text(txn.name).font(.body.weight(.medium)).lineLimit(1)
                }
                HStack(spacing: 4) {
                    if let cat = txn.categoryName {
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
