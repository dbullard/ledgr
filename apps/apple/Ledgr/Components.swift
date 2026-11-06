import SwiftUI

extension Color {
    /// Card background that works on both platforms.
    static var card: Color {
        #if os(iOS)
        Color(.secondarySystemGroupedBackground)
        #else
        Color.primary.opacity(0.07)
        #endif
    }

    static var canvas: Color {
        #if os(iOS)
        Color(.systemGroupedBackground)
        #else
        Color(nsColor: .windowBackgroundColor)
        #endif
    }

    static let income = Color(red: 0.13, green: 0.65, blue: 0.38)
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
        VStack(alignment: .leading, spacing: 12) {
            if title != nil || trailing != nil {
                HStack {
                    if let title { Text(title).font(.headline) }
                    Spacer()
                    trailing
                }
            }
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
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

    var body: some View {
        Image(systemName: Icons.symbol(icon))
            .font(.system(size: size * 0.44, weight: .semibold))
            .foregroundStyle(Color.accentColor)
            .frame(width: size, height: size)
            .background(Color.accentColor.opacity(0.14), in: Circle())
    }
}

struct TxnRow: View {
    let txn: Txn

    var body: some View {
        HStack(spacing: 12) {
            CategoryBadge(icon: txn.isTransfer ? "arrow-left-right" : txn.categoryIcon)
            VStack(alignment: .leading, spacing: 2) {
                Text(txn.name).font(.body).lineLimit(1)
                HStack(spacing: 4) {
                    if let cat = txn.categoryName {
                        Text(cat)
                    } else {
                        Text("Uncategorized").foregroundStyle(.orange)
                    }
                    Text("· \(txn.accountName)").lineLimit(1)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(Fmt.money(txn.normalizedAmount))
                    .font(.body.monospacedDigit())
                    .foregroundStyle(txn.normalizedAmount > 0 ? Color.income : Color.primary)
                if txn.pending { Text("Pending").font(.caption2).foregroundStyle(.secondary) }
            }
        }
        .contentShape(Rectangle())
    }
}
