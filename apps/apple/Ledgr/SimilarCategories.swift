import SwiftUI
#if canImport(FoundationModels)
import FoundationModels
#endif

/// After you change a transaction's category, finds other transactions with the same amount from the
/// same merchant that have a different category and offers to match them. The on-device model decides
/// which names are the same merchant; without it, matching falls back to comparing names directly.
@MainActor
final class SimilarCategories: ObservableObject {
    static let shared = SimilarCategories()

    struct Offer: Identifiable {
        let id = UUID()
        let categoryId: String
        let categoryName: String
        let reference: Txn
        let matches: [Txn]
    }

    @Published var offer: Offer?
    @Published var message: String?
    private var task: Task<Void, Never>?
    private var dismissTask: Task<Void, Never>?

    func check(after txn: Txn, api: API) {
        guard let cid = txn.categoryId, let cname = txn.categoryName, !txn.isTransfer else { return }
        task?.cancel()
        task = Task {
            // Exact amount from the server (older servers ignore this, so the exact-amount filter below still applies).
            guard let page: TxnPage = try? await api.get("api/native/transactions", query: ["amount": String(abs(txn.normalizedAmount)), "limit": "100"]) else { return }
            let candidates = page.rows.filter {
                $0.id != txn.id && !$0.isTransfer && $0.normalizedAmount == txn.normalizedAmount && $0.categoryId != cid && Self.looselySame(txn, $0)
            }
            guard !candidates.isEmpty, !Task.isCancelled else { return }
            let confirmed = await OnDeviceAI.sameMerchant(reference: txn, candidates: Array(candidates.prefix(25)))
                ?? candidates.filter { Self.strictlySame(txn, $0) }
            guard !confirmed.isEmpty, !Task.isCancelled else { return }
            offer = Offer(categoryId: cid, categoryName: cname, reference: txn, matches: confirmed)
            message = nil
            scheduleDismiss()
        }
    }

    func apply(_ offer: Offer, to selected: [Txn], api: API) async {
        var updated: [Txn] = []
        for t in selected {
            if let u: Txn = try? await api.patch("api/native/transactions/\(t.id)", body: ["categoryId": offer.categoryId]) { updated.append(u) }
        }
        self.offer = nil
        if !updated.isEmpty {
            api.noteBulkChanged(updated)
            message = "Set \(updated.count) to \(offer.categoryName)"
            scheduleDismiss(after: 3)
        }
    }

    func dismiss() { offer = nil; message = nil }

    private func scheduleDismiss(after seconds: Double = 20) {
        dismissTask?.cancel()
        dismissTask = Task {
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            offer = nil; message = nil
        }
    }

    // MARK: Name matching

    private static let noise: Set<String> = ["dda", "pin", "pos", "pur", "rtn", "the", "and", "inc", "llc", "www", "com", "debit", "card", "purchase", "payment", "recur", "bill"]

    static func tokens(_ t: Txn) -> Set<String> {
        let text = [t.displayName, t.name, t.merchantName ?? ""].joined(separator: " ").lowercased()
        return Set(text.split { !$0.isLetter }.map(String.init).filter { $0.count > 2 && !noise.contains($0) })
    }

    /// Shares at least one meaningful word (or the merchant): worth showing to the model.
    static func looselySame(_ a: Txn, _ b: Txn) -> Bool {
        if let m = a.merchantName?.lowercased(), !m.isEmpty, m == b.merchantName?.lowercased() { return true }
        return !tokens(a).isDisjoint(with: tokens(b))
    }

    /// Without the model: same merchant, or at least half of the shorter name's words in common.
    static func strictlySame(_ a: Txn, _ b: Txn) -> Bool {
        if let m = a.merchantName?.lowercased(), !m.isEmpty, m == b.merchantName?.lowercased() { return true }
        if a.displayName.lowercased() == b.displayName.lowercased() { return true }
        let ta = tokens(a), tb = tokens(b)
        let shared = ta.intersection(tb).count
        return shared > 0 && Double(shared) / Double(min(ta.count, tb.count)) >= 0.5
    }
}

extension OnDeviceAI {
    /// Which of these same-amount candidates are the same merchant as `reference`? nil when the model
    /// isn't available or didn't answer, so the caller can fall back to plain name matching.
    static func sameMerchant(reference: Txn, candidates: [Txn]) async -> [Txn]? {
        #if canImport(FoundationModels)
        if #available(iOS 27.0, macOS 27.0, *), isAvailable {
            let list = candidates.enumerated().map { "\($0.offset + 1). \($0.element.name)\($0.element.merchantName.map { " / \($0)" } ?? "") (\($0.element.accountName), \($0.element.date))" }.joined(separator: "\n")
            let prompt = """
            Reference charge: \(reference.name)\(reference.merchantName.map { " / \($0)" } ?? "") (\(reference.accountName)), \(Fmt.money(abs(reference.normalizedAmount)))

            Other charges for the same amount:
            \(list)
            """
            let session = LanguageModelSession(
                model: .default,
                instructions: "You compare bank transaction descriptions. List the numbers of the other charges that are clearly from the same merchant as the reference charge. Bank descriptions are noisy (store numbers, card digits, city), so ignore those. If unsure, leave a charge out.")
            guard let r = try? await session.respond(to: prompt, generating: SameMerchantPick.self) else { return nil }
            return r.content.numbers.compactMap { n in candidates.indices.contains(n - 1) ? candidates[n - 1] : nil }
        }
        #endif
        return nil
    }
}

#if canImport(FoundationModels)
@available(iOS 27.0, macOS 27.0, *)
@Generable
struct SameMerchantPick {
    @Guide(description: "Numbers of the other charges that are clearly from the same merchant; empty if none")
    var numbers: [Int]
}
#endif

/// Floating prompt offered after a category change: "Also set 3 similar to Restaurants?"
struct SimilarCategoryBanner: View {
    @EnvironmentObject var api: API
    @ObservedObject private var similar = SimilarCategories.shared
    @State private var showReview = false

    var body: some View {
        Group {
            if let offer = similar.offer {
                HStack(spacing: 12) {
                    Image(systemName: "sparkles").foregroundStyle(Color.accentColor)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Also set \(offer.matches.count) similar to \(offer.categoryName)?").font(.subheadline.weight(.semibold))
                        Text("Same merchant, \(Fmt.money(abs(offer.reference.normalizedAmount)))").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    Button("Review") { showReview = true }
                        .buttonStyle(.borderedProminent).controlSize(.small)
                    Button { similar.dismiss() } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Dismiss")
                }
                .padding(12)
                .frame(maxWidth: 520)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .sheet(isPresented: $showReview) { SimilarReviewSheet(offer: offer) }
            } else if let message = similar.message {
                Label(message, systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.medium))
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .padding(.bottom, 16)
        .animation(.spring(response: 0.4, dampingFraction: 1), value: similar.offer?.id)
        .animation(.spring(response: 0.4, dampingFraction: 1), value: similar.message)
    }
}

struct SimilarReviewSheet: View {
    let offer: SimilarCategories.Offer
    @EnvironmentObject var api: API
    @Environment(\.dismiss) private var dismiss
    @State private var selected: Set<String>
    @State private var working = false

    init(offer: SimilarCategories.Offer) {
        self.offer = offer
        // Start with the ones that still need attention; reviewed ones with another category stay as they are.
        _selected = State(initialValue: Set(offer.matches.filter { $0.categoryId == nil || !$0.reviewed }.map(\.id)))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Set to \(offer.categoryName)").font(.title3.weight(.semibold))
                Spacer()
                Button("Cancel") { dismiss() }
            }
            Text("Same amount and merchant as \(offer.reference.displayName).").font(.footnote).foregroundStyle(.secondary)
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(offer.matches) { t in
                        Button {
                            if selected.contains(t.id) { selected.remove(t.id) } else { selected.insert(t.id) }
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: selected.contains(t.id) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(selected.contains(t.id) ? Color.accentColor : .secondary)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(t.displayName).foregroundStyle(Color.primary).lineLimit(1)
                                    Text("\(Fmt.shortDate(t.date)) · \(t.accountName) · \(t.categoryName ?? "Uncategorized")")
                                        .font(.caption).foregroundStyle(t.categoryName == nil ? Color.alert : .secondary).lineLimit(1)
                                }
                                Spacer()
                                Text(Fmt.money(t.normalizedAmount)).monospacedDigit().foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 8).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        Divider()
                    }
                }
            }
            Button {
                working = true
                Task {
                    await SimilarCategories.shared.apply(offer, to: offer.matches.filter { selected.contains($0.id) }, api: api)
                    dismiss()
                }
            } label: {
                HStack { if working { ProgressView().controlSize(.small) }; Text("Change \(selected.count)") }.frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(selected.isEmpty || working)
        }
        .padding(20)
        .frame(minWidth: 420, minHeight: 360)
    }
}
