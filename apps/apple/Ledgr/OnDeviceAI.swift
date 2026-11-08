import SwiftUI
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Apple's on-device model for categorizing, budget advice and report summaries
/// (iOS 27 / macOS 27 with Apple Intelligence). Everything runs on this device,
/// so no transaction data leaves it for these features. When the device can't
/// run the model, `isAvailable` is false and the UI hides the AI controls, so
/// the app behaves exactly as before.
enum OnDeviceAI {
    static var isAvailable: Bool {
        #if canImport(FoundationModels)
        if #available(iOS 27.0, macOS 27.0, *) {
            if case .available = SystemLanguageModel.default.availability { return true }
        }
        #endif
        return false
    }

    /// Picks the best category for a transaction from the user's own list.
    /// `examples` are recent already-categorized transactions: "name → category".
    static func suggestCategory(name: String, merchant: String?, cents: Int, groups: [CategoryGroup],
                                examples: [(name: String, category: String)]) async -> Category? {
        #if canImport(FoundationModels)
        if #available(iOS 27.0, macOS 27.0, *) {
            let wantsIncome = cents > 0
            let cats = groups.flatMap { g in g.categories.map { (g.name, $0) } }
                .filter { $0.1.isIncome == wantsIncome }
            guard !cats.isEmpty else { return nil }
            let list = cats.map { "\($0.1.name) (\($0.0))" }.joined(separator: "\n")
            let shots = examples.prefix(30).map { "\($0.name) → \($0.category)" }.joined(separator: "\n")
            let prompt = """
            Categories:
            \(list)

            Already categorized by the user:
            \(shots.isEmpty ? "(none)" : shots)

            Transaction: \(name)\(merchant.map { " / \($0)" } ?? "")  \(Fmt.money(abs(cents))) (\(wantsIncome ? "money in" : "money out"))
            """
            let session = LanguageModelSession(
                model: .default,
                instructions: "You file bank transactions into the user's budget categories. Answer with exactly one category name copied from the list. If nothing fits, answer with an empty string. Follow the user's earlier choices when the merchant matches.")
            guard let r = try? await session.respond(to: prompt, generating: CategoryPick.self) else { return nil }
            let pick = r.content.categoryName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return cats.first { $0.1.name.lowercased() == pick }?.1
        }
        #endif
        return nil
    }

    /// Tidies a detected charge into a friendly name and judges whether it looks like a real
    /// subscription or bill (versus habit spending such as a coffee shop). Nil when unavailable.
    static func judgeSubscription(rawName: String, frequency: String, cents: Int) async -> (name: String, isSubscription: Bool)? {
        #if canImport(FoundationModels)
        if #available(iOS 27.0, macOS 27.0, *) {
            let session = LanguageModelSession(
                model: .default,
                instructions: "You review repeating bank charges. Give the service's plain brand name (e.g. 'Netflix', 'Verizon') without store numbers or codes. Mark isSubscription true for subscriptions, memberships, utilities, insurance, rent, loans and phone or internet bills; false for habit spending at shops, restaurants, gas or groceries.")
            let prompt = "Charge: \(rawName), about \(Fmt.money(cents)) \(frequency)."
            guard let r = try? await session.respond(to: prompt, generating: SubscriptionVerdict.self) else { return nil }
            let n = r.content.name.trimmingCharacters(in: .whitespacesAndNewlines)
            return (n.isEmpty ? rawName : n, r.content.isSubscription)
        }
        #endif
        return nil
    }

    /// Plain-language read of a budget month: what's on track, what's at risk,
    /// and where an unbudgeted category might deserve a limit.
    static func budgetAdvice(_ d: BudgetResponse) async -> String? {
        var t = "Month \(d.month). Budgeted \(Fmt.moneyWhole(d.summary.totalBudgeted)), spent \(Fmt.moneyWhole(d.summary.totalSpent)), remaining \(Fmt.moneyWhole(d.summary.totalRemaining)).\n"
        for g in d.groups {
            for c in g.categories {
                t += "\(c.categoryName) (\(g.groupName)): limit \(Fmt.moneyWhole(c.limitAmount)), spent \(Fmt.moneyWhole(c.spent))\(c.isFixed ? ", fixed bill" : "")\n"
            }
        }
        if !d.unbudgeted.categories.isEmpty {
            t += "Spent with no budget: " + d.unbudgeted.categories.map { "\($0.categoryName) \(Fmt.moneyWhole($0.spent))" }.joined(separator: ", ") + "\n"
        }
        return await write(
            instructions: "You are a calm household budgeting assistant. Using only the numbers given, write 3 to 4 short bullet points (start each with •): what is on track, which categories are over or close to their limit, and which unbudgeted spending deserves a limit with a suggested amount. No greetings, no markdown, no invented numbers.",
            data: t)
    }

    /// Short summary of whichever report is on screen, from a compact text dump of its rows.
    static func reportSummary(title: String, range: String, data: String) async -> String? {
        await write(
            instructions: "You summarize personal finance reports. Using only the numbers given, write 3 short bullet points (start each with •): the headline, the biggest change or outlier, and one thing worth a look. Amounts are US dollars. No greetings, no markdown, no invented numbers.",
            data: "Report: \(title). Range: \(range).\n\(data)")
    }

    private static func write(instructions: String, data: String) async -> String? {
        #if canImport(FoundationModels)
        if #available(iOS 27.0, macOS 27.0, *) {
            let session = LanguageModelSession(model: .default, instructions: instructions)
            guard let r = try? await session.respond(to: String(data.prefix(6000))) else { return nil }
            let s = r.content.trimmingCharacters(in: .whitespacesAndNewlines)
            return s.isEmpty ? nil : s
        }
        #endif
        return nil
    }
}

#if canImport(FoundationModels)
@available(iOS 27.0, macOS 27.0, *)
@Generable
struct SubscriptionVerdict {
    @Guide(description: "Friendly brand or service name, no store numbers")
    var name: String
    @Guide(description: "True if this is a subscription, membership, utility, insurance, rent, loan or phone/internet bill")
    var isSubscription: Bool
}

@available(iOS 27.0, macOS 27.0, *)
@Generable
struct CategoryPick {
    @Guide(description: "One category name copied exactly from the list, or an empty string if none fits")
    var categoryName: String
}
#endif

/// Card with a "Summarize on device" button that fills in with model text.
/// Renders nothing on devices without Apple Intelligence.
struct OnDeviceInsightCard: View {
    let title: String
    let prompt: String
    /// Re-run (and clear old text) when this changes, e.g. the month or report range.
    let resetKey: String
    let generate: () async -> String?

    @State private var text: String?
    @State private var busy = false
    @State private var failed = false

    var body: some View {
        if OnDeviceAI.isAvailable {
            Card(title, trailing: AnyView(Label("On device", systemImage: "lock.fill").font(.caption).foregroundStyle(.secondary))) {
                if let text {
                    Text(text).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                } else if failed {
                    Text("Couldn't generate this right now.").font(.footnote).foregroundStyle(.secondary)
                }
                Button {
                    busy = true; failed = false
                    Task {
                        text = await generate()
                        failed = text == nil
                        busy = false
                    }
                } label: {
                    HStack(spacing: 6) {
                        if busy { ProgressView().controlSize(.small) } else { Image(systemName: "sparkles") }
                        Text(text == nil ? prompt : "Refresh")
                    }
                }
                .disabled(busy)
            }
            .onChange(of: resetKey) { _, _ in text = nil; failed = false }
        }
    }
}

/// Suggests categories for uncategorized transactions one at a time, newest-seen
/// first. Every answer (including "no match") is cached on the Ledgr server, not
/// in the app, so a transaction is only ever sent to the model once across all
/// of the household's devices. Learns from the user's past categorizations.
@MainActor
final class CategorySuggester: ObservableObject {
    static let shared = CategorySuggester()

    /// Transaction id → suggested category, until the user confirms or dismisses it.
    @Published private(set) var suggestions: [String: Category] = [:]

    /// Rows the server (or the model, this session) has answered for, so views don't re-ask.
    private var known = Set<String>()
    private var seen = Set<String>()          // ids already taken in (lookup, queued or done)
    private var lookup: [Txn] = []
    private var lookupTask: Task<Void, Never>?
    private var queue: [Txn] = []
    private var worker: Task<Void, Never>?
    private var groups: [CategoryGroup] = []
    private var examples: [(name: String, category: String)] = []
    private var examplesLoaded = false

    func isKnown(_ id: String) -> Bool { known.contains(id) }

    func enqueue(_ txn: Txn, api: API) {
        guard OnDeviceAI.isAvailable, txn.categoryName == nil, !txn.isTransfer, seen.insert(txn.id).inserted else { return }
        lookup.append(txn)
        guard lookupTask == nil else { return }
        // Batch rows that appear together into one server check.
        lookupTask = Task {
            try? await Task.sleep(for: .milliseconds(150))
            await checkServer(api: api)
        }
    }

    /// Call when the user confirms, dismisses, or picks a category by hand.
    func resolve(_ id: String, api: API) {
        suggestions[id] = nil
        known.insert(id)
        seen.insert(id)
        Task { try? await api.put("api/native/category-suggestions/\(id)", body: ["categoryId": NSNull()]) }
    }

    /// Ask the server which of these rows it has already answered; the rest go to the model.
    private func checkServer(api: API) async {
        let batch = lookup
        lookup = []
        lookupTask = nil
        if groups.isEmpty, let g: [CategoryGroup] = try? await api.get("api/native/categories") { groups = g.alphabetical; CategoryCache.groups = groups }
        var cached: [String: String?]?
        for chunk in stride(from: 0, to: batch.count, by: 100).map({ Array(batch[$0..<min($0 + 100, batch.count)]) }) {
            let ids = chunk.map(\.id).joined(separator: ",")
            guard let got: [String: String?] = try? await api.get("api/native/category-suggestions", query: ["ids": ids]) else { continue }
            cached = (cached ?? [:]).merging(got) { a, _ in a }
        }
        let byId = Dictionary(uniqueKeysWithValues: groups.flatMap(\.categories).map { ($0.id, $0) })
        for txn in batch {
            if let answer = cached?[txn.id] {
                known.insert(txn.id)
                if let cid = answer, let c = byId[cid] { suggestions[txn.id] = c }
            } else if cached != nil {
                queue.append(txn)   // server reachable and has no answer: ask the model
            } else {
                seen.remove(txn.id) // server unreachable: try again next time the row appears
            }
        }
        if worker == nil, !queue.isEmpty { worker = Task { await run(api: api) } }
    }

    private func run(api: API) async {
        defer { worker = nil }
        await loadExamples(api: api)
        // Newest enqueued first, so rows on screen right now go before ones scrolled past.
        while let txn = queue.popLast() {
            if Task.isCancelled { return }
            let pick = await OnDeviceAI.suggestCategory(
                name: txn.name, merchant: txn.merchantName, cents: txn.normalizedAmount,
                groups: groups, examples: relevantExamples(for: txn))
            known.insert(txn.id)
            if let pick { suggestions[txn.id] = pick }
            // Cache on the server; if this fails the row is simply asked again next launch.
            try? await api.put("api/native/category-suggestions/\(txn.id)", body: ["categoryId": pick?.id ?? NSNull()])
        }
    }

    private func loadExamples(api: API) async {
        guard !examplesLoaded else { return }
        // Past choices: the most recent categorized transactions, up to three pages.
        var cursor: String?
        for _ in 0..<3 {
            var q = ["limit": "100"]
            if let cursor { q["cursor"] = cursor }
            guard let page: TxnPage = try? await api.get("api/native/transactions", query: q) else { break }
            examples += page.rows.compactMap { t in t.categoryName.map { (t.name, $0) } }.filter { !$0.name.isEmpty }
            cursor = page.nextCursor
            if cursor == nil { break }
        }
        examplesLoaded = true
    }

    /// Examples whose name shares a word with this transaction come first, then the most recent ones.
    private func relevantExamples(for txn: Txn) -> [(name: String, category: String)] {
        func words(_ s: String) -> Set<String> {
            Set(s.lowercased().split { !$0.isLetter }.map(String.init).filter { $0.count > 2 })
        }
        let mine = words(txn.name).union(txn.merchantName.map(words) ?? [])
        let related = examples.filter { !words($0.name).isDisjoint(with: mine) }.prefix(15)
        let recent = examples.prefix(15)
        var out: [(name: String, category: String)] = []
        var done = Set<String>()
        for e in Array(related) + Array(recent) where done.insert(e.name + "→" + e.category).inserted { out.append(e) }
        return out
    }
}
