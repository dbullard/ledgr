import SwiftUI

/// One non-transaction hit from `GET /api/native/search`.
struct SearchHit: Codable, Identifiable, Hashable {
    let kind: String
    let id: String
    let title: String
    let subtitle: String?
    let amount: Int?

    /// The screen this hit lives on.
    var destination: TabChoice? {
        switch kind {
        case "account": return .accounts
        case "category": return .categories
        case "rule": return .rules
        case "recurring": return .recurring
        case "item": return .items
        case "holding": return .investments
        default: return nil
        }
    }

    var symbol: String { destination?.symbol ?? "magnifyingglass" }

    /// Group heading, in the order groups are shown.
    var groupTitle: String { destination?.title ?? "Other" }
}

struct SearchResponse: Codable {
    let transactions: [Txn]
    let hits: [SearchHit]
}

/// One selectable line in the search panel.
private enum SearchRow: Identifiable {
    case suggestion(String)
    case recent(String)
    case page(TabChoice)
    case txn(Txn)
    case hit(SearchHit)

    var id: String {
        switch self {
        case .suggestion(let s): return "suggestion:\(s)"
        case .recent(let s): return "recent:\(s)"
        case .page(let p): return "page:\(p.rawValue)"
        case .txn(let t): return "txn:\(t.id)"
        case .hit(let h): return "hit:\(h.kind):\(h.id)"
        }
    }

    /// Rows that open something get a chevron on iPhone; suggestions just fill the field.
    var opensSomething: Bool {
        switch self {
        case .suggestion, .recent: return false
        default: return true
        }
    }
}

/// Spotlight-style search over the whole app: results as you type, arrow keys and Return to
/// pick on Mac. Anything that reads like a question is answered right in the list by Apple's
/// on-device model (nothing leaves the device), with the figures laid out as a table.
///
/// Mac: a wide panel with the field on top (⌘K). iPhone: results in rounded cards with the
/// field at the bottom, within thumb reach and above the keyboard, as in Spotlight.
struct SearchView: View {
    /// Mac only: jump the main window to a screen. On iPhone the screen is pushed here instead,
    /// because the tab bar only holds four of them.
    var onOpen: (AppSection) -> Void = { _ in }

    @EnvironmentObject var api: API
    @Environment(\.dismiss) private var dismiss
    @AppStorage("recentSearches") private var recentRaw = ""
    @FocusState private var focused: Bool
    @State private var path = NavigationPath()
    @State private var query = ""
    @State private var response = SearchResponse(transactions: [], hits: [])
    @State private var searching = false
    @State private var failed = false
    @State private var selected: String?
    @State private var answer: String?
    @State private var tables: [AnswerTable] = []
    @State private var asking = false
    @State private var askFailed = false

    private var trimmed: String { query.trimmingCharacters(in: .whitespaces) }
    private var recents: [String] { recentRaw.split(separator: "\n").map(String.init) }

    #if os(iOS)
    private let isPhone = true
    #else
    private let isPhone = false
    #endif

    /// Starter questions shown before anything is typed, only where the model can answer them.
    private static let suggestedQuestions = [
        "What subscriptions do I have?",
        "How much did I spend this month?",
        "Am I over budget anywhere?",
        "What's my net worth?",
        "How do I change a transaction's category?",
    ]

    // MARK: Question detection

    private static let questionWords: Set<String> = [
        "how", "what", "whats", "why", "when", "where", "who", "which", "can", "do", "does", "did",
        "is", "are", "am", "should", "will", "show", "tell", "compare", "list",
    ]

    /// True for text like "how much did I spend on food" or anything ending in "?".
    static func looksLikeQuestion(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespaces).lowercased()
        guard t.count >= 4 else { return false }
        if t.hasSuffix("?") { return true }
        let words = t.split(separator: " ")
        guard words.count >= 3, let first = words.first else { return false }
        return questionWords.contains(String(first))
    }

    private var wantsAnswer: Bool { OnDeviceAI.isAvailable && Self.looksLikeQuestion(trimmed) }

    // MARK: Rows

    private var sections: [(title: String, rows: [SearchRow])] {
        var out: [(String, [SearchRow])] = []
        if trimmed.count < 2 {
            if OnDeviceAI.isAvailable { out.append(("Suggested", Self.suggestedQuestions.map(SearchRow.suggestion))) }
            if !recents.isEmpty { out.append(("Recent", recents.map(SearchRow.recent))) }
            out.append(("Go to", TabChoice.allCases.map(SearchRow.page)))
            return out
        }
        if !response.transactions.isEmpty { out.append(("Transactions", response.transactions.map(SearchRow.txn))) }
        let order = TabChoice.allCases.map(\.title)
        let grouped = Dictionary(grouping: response.hits, by: \.groupTitle)
        for title in grouped.keys.sorted(by: { (order.firstIndex(of: $0) ?? 99) < (order.firstIndex(of: $1) ?? 99) }) {
            out.append((title, (grouped[title] ?? []).map(SearchRow.hit)))
        }
        // Screens whose name matches, like Spotlight offering the app itself.
        let pages = TabChoice.allCases.filter { $0.title.localizedCaseInsensitiveContains(trimmed) }
        if !pages.isEmpty { out.append(("Go to", pages.map(SearchRow.page))) }
        return out
    }

    private var flatRows: [SearchRow] { sections.flatMap(\.rows) }

    // MARK: Body

    var body: some View {
        NavigationStack(path: $path) {
            panel
                .background(.regularMaterial)
                .navigationDestination(for: Txn.self) { TransactionDetailView(initial: $0) }
                .navigationDestination(for: TabChoice.self) { $0.screen }
                #if os(iOS)
                .toolbar(.hidden, for: .navigationBar)
                #endif
                .onAppear { focused = true }
        }
        #if os(macOS)
        .frame(width: 660, height: 480)
        #else
        .presentationDragIndicator(.visible)
        #endif
        .task(id: trimmed) { await run() }
        .task(id: wantsAnswer ? trimmed : "") { await maybeAsk() }
        .onChange(of: flatRows.map(\.id)) { _, ids in
            if let s = selected, ids.contains(s) { return }
            selected = ids.first
        }
    }

    @ViewBuilder private var panel: some View {
        #if os(iOS)
        results
            .safeAreaInset(edge: .bottom, spacing: 0) { field }
        #else
        VStack(spacing: 0) {
            field
            Divider()
            results
        }
        #endif
    }

    // MARK: Field

    private var field: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(isPhone ? .body : .title2)
                .foregroundStyle(.secondary)
            TextField("Search Ledgr or ask a question", text: $query)
                .textFieldStyle(.plain)
                .font(isPhone ? .body : .system(size: 22, weight: .light))
                .focused($focused)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit { if let row = selectedRow, !isPhone { activate(row) } }
                .onKeyPress(.downArrow) { move(1); return .handled }
                .onKeyPress(.upArrow) { move(-1); return .handled }
                #if os(macOS)
                .onExitCommand { dismiss() }
                #endif
            if searching || asking { ProgressView().controlSize(.small) }
            if !query.isEmpty {
                Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                    .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, isPhone ? 14 : 18)
        .padding(.vertical, isPhone ? 11 : 14)
        .background {
            if isPhone { Capsule().fill(Color.primary.opacity(0.09)) }
        }
        .padding(.horizontal, isPhone ? 12 : 0)
        .padding(.vertical, isPhone ? 8 : 0)
        .background {
            #if os(iOS)
            Rectangle().fill(.regularMaterial).ignoresSafeArea()
            #endif
        }
    }

    // MARK: Results

    private var results: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: isPhone ? 14 : 2) {
                    if wantsAnswer { answerCard }
                    ForEach(tables) { AnswerTableCard(table: $0, collapsedRows: isPhone ? 5 : 8) }
                    ForEach(sections, id: \.title) { section in
                        sectionView(section.title, section.rows)
                    }
                    if trimmed.count >= 2 && failed { message("Couldn't search. Check your server connection.", "wifi.exclamationmark") }
                    else if trimmed.count >= 2 && flatRows.isEmpty && !searching && !wantsAnswer { message("No results for “\(trimmed)”", "magnifyingglass") }
                }
                .padding(isPhone ? 16 : 8)
            }
            #if os(iOS)
            .scrollDismissesKeyboard(.interactively)
            #endif
            .onChange(of: selected) { _, id in
                if let id, !isPhone { withAnimation(.easeOut(duration: 0.12)) { proxy.scrollTo(id) } }
            }
        }
    }

    @ViewBuilder private func sectionView(_ title: String, _ rows: [SearchRow]) -> some View {
        if isPhone {
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.footnote.weight(.semibold)).foregroundStyle(.secondary).padding(.horizontal, 4)
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        rowView(row)
                        if index < rows.count - 1 { Divider().padding(.leading, 56) }
                    }
                }
                .background(RoundedRectangle(cornerRadius: 14).fill(Color.primary.opacity(0.07)))
                .clipShape(RoundedRectangle(cornerRadius: 14))
            }
        } else {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                .padding(.horizontal, 10).padding(.top, 10).padding(.bottom, 2)
            ForEach(rows) { rowView($0).id($0.id) }
        }
    }

    // MARK: Answer

    @ViewBuilder private var answerCard: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "sparkles").font(.title3).foregroundStyle(Color.accentColor).frame(width: 28)
            VStack(alignment: .leading, spacing: 6) {
                if let answer {
                    Text(answer).font(.body).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                } else if askFailed && tables.isEmpty {
                    Text("Couldn't answer that right now.").foregroundStyle(.secondary)
                } else if asking {
                    Text("Thinking…").foregroundStyle(.secondary)
                }
                Label("Answered on this device", systemImage: "lock.fill").font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.accentColor.opacity(0.12)))
        .padding(.bottom, isPhone ? 0 : 4)
    }

    // MARK: Rows

    @ViewBuilder private func rowView(_ row: SearchRow) -> some View {
        let isSelected = !isPhone && selected == row.id
        Button { selected = row.id; activate(row) } label: {
            HStack(spacing: 12) {
                icon(for: row)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title(of: row)).lineLimit(isPhone ? 2 : 1)
                    if let sub = subtitle(of: row) { Text(sub).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                }
                Spacer(minLength: 8)
                if let trailing = trailing(of: row) { Text(trailing).monospacedDigit().foregroundStyle(.secondary) }
                #if os(macOS)
                if isSelected { Image(systemName: "return").font(.caption).foregroundStyle(.secondary) }
                #else
                if row.opensSomething { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary) }
                #endif
            }
            .padding(.horizontal, 10)
            .padding(.vertical, isPhone ? 10 : 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(isSelected ? Color.accentColor.opacity(0.18) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func icon(for row: SearchRow) -> some View {
        let symbol: String
        switch row {
        case .suggestion: symbol = "sparkles"
        case .recent: symbol = "clock"
        case .page(let p): symbol = p.symbol
        case .txn: symbol = "creditcard"
        case .hit(let h): symbol = h.symbol
        }
        return Image(systemName: symbol)
            .font(.system(size: 14))
            .foregroundStyle(.secondary)
            .frame(width: 28, height: 28)
            .background(RoundedRectangle(cornerRadius: 7).fill(.quaternary.opacity(0.6)))
    }

    private func title(of row: SearchRow) -> String {
        switch row {
        case .suggestion(let s), .recent(let s): return s
        case .page(let p): return p.title
        case .txn(let t): return t.displayName
        case .hit(let h): return h.title
        }
    }

    private func subtitle(of row: SearchRow) -> String? {
        switch row {
        case .txn(let t): return t.date
        case .hit(let h): return h.subtitle.flatMap { $0.isEmpty ? nil : $0.capitalized }
        default: return nil
        }
    }

    private func trailing(of row: SearchRow) -> String? {
        switch row {
        case .txn(let t): return Fmt.money(t.normalizedAmount)
        case .hit(let h): return h.amount.map(Fmt.money)
        default: return nil
        }
    }

    private func message(_ text: String, _ symbol: String) -> some View {
        Label(text, systemImage: symbol).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity).padding(.vertical, 30)
    }

    // MARK: Actions

    private var selectedRow: SearchRow? { flatRows.first { $0.id == selected } ?? flatRows.first }

    private func move(_ delta: Int) {
        let ids = flatRows.map(\.id)
        guard !ids.isEmpty else { return }
        let current = selected.flatMap(ids.firstIndex(of:)) ?? 0
        selected = ids[max(0, min(ids.count - 1, current + delta))]
    }

    private func activate(_ row: SearchRow) {
        switch row {
        case .suggestion(let text), .recent(let text):
            query = text
        case .page(let choice):
            open(choice)
        case .txn(let txn):
            remember()
            path.append(txn)
        case .hit(let hit):
            remember()
            if let dest = hit.destination { open(dest) }
        }
    }

    private func open(_ choice: TabChoice) {
        #if os(macOS)
        onOpen(choice.section)
        dismiss()
        #else
        path.append(choice)
        #endif
    }

    /// Keeps the last few searches that led somewhere.
    private func remember() {
        guard trimmed.count >= 2 else { return }
        var list = recents.filter { $0.caseInsensitiveCompare(trimmed) != .orderedSame }
        list.insert(trimmed, at: 0)
        recentRaw = list.prefix(5).joined(separator: "\n")
    }

    // MARK: Loading

    /// Waits a beat after typing stops, and drops the answer if a newer search has started.
    private func run() async {
        guard trimmed.count >= 2 else {
            response = SearchResponse(transactions: [], hits: [])
            failed = false
            return
        }
        try? await Task.sleep(for: .milliseconds(250))
        if Task.isCancelled { return }
        searching = true
        defer { searching = false }
        do {
            let result: SearchResponse = try await api.get("api/native/search", query: ["q": trimmed])
            if Task.isCancelled { return }
            response = result
            failed = false
        } catch {
            if Task.isCancelled { return }
            failed = true
        }
    }

    /// Answers a question-shaped query once typing pauses. The on-device model calls tools to
    /// look up the subscriptions, budget, spending, accounts or transactions it needs; the
    /// tools' tables are shown as they are, with the model's few sentences above them.
    private func maybeAsk() async {
        answer = nil
        tables = []
        askFailed = false
        guard wantsAnswer else { asking = false; return }
        try? await Task.sleep(for: .milliseconds(800))
        if Task.isCancelled { return }
        let question = trimmed
        asking = true
        defer { asking = false }

        let result = await OnDeviceAI.answer(question: question, api: api)
        if Task.isCancelled { return }
        answer = result.text
        tables = result.tables
        askFailed = result.text == nil && result.tables.isEmpty
    }
}

/// A list under an answer: title, rows with a detail line and amount, and a footer. Long lists
/// show the first few rows with a button for the rest.
private struct AnswerTableCard: View {
    let table: AnswerTable
    let collapsedRows: Int
    @State private var expanded = false

    private var shown: [AnswerTable.Row] { expanded ? table.rows : Array(table.rows.prefix(collapsedRows)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(table.title).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 6)
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, row in
                if index > 0 { Divider().padding(.leading, 14) }
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.name).lineLimit(2)
                        if let detail = row.detail, !detail.isEmpty {
                            Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 8)
                    if let amount = row.amount { Text(amount).monospacedDigit() }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
            }
            if table.rows.count > collapsedRows {
                Divider().padding(.leading, 14)
                Button { withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() } } label: {
                    Text(expanded ? "Show less" : "Show all \(table.rows.count)")
                        .font(.subheadline)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
            }
            if let footer = table.footer {
                Divider()
                Text(footer).font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 14).padding(.vertical, 10)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.primary.opacity(0.07)))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}
