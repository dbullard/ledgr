import SwiftUI

/// What a tapped report row stands for: one category's spending over the report's range.
struct DrillDown: Hashable {
    let title: String
    /// nil means uncategorized.
    let categoryId: String?
    let range: String
}

/// The transactions behind one line of the spending report. Same rows as the web drill-down sheet;
/// tap one to open it and edit as usual.
struct DrillDownView: View {
    let drill: DrillDown
    @EnvironmentObject var api: API
    @State private var rows: [Txn] = []
    @State private var cursor: String?
    @State private var loaded = false
    @State private var error: String?
    @State private var loadingMore = false

    private var total: Int { rows.filter { !$0.isTransfer && $0.normalizedAmount < 0 }.reduce(0) { $0 + abs($1.normalizedAmount) } }

    var body: some View {
        List {
            if loaded && !rows.isEmpty {
                Section { HStack { Text("Shown"); Spacer(); Text(Fmt.money(total)).monospacedDigit() } }
                    .listRowBackground(Color.card)
            }
            ForEach(rows) { txn in
                NavigationLink(value: txn) { TxnRow(txn: txn) }
                    .listRowBackground(Color.card)
                    .onAppear { if txn.id == rows.last?.id { Task { await loadMore() } } }
            }
            if loadingMore { ProgressView().frame(maxWidth: .infinity) }
        }
        .scrollContentBackground(.hidden)
        .background(Color.canvas)
        .navigationTitle(drill.title)
        .overlay {
            if !loaded && error == nil { LoadingPlaceholder() }
            else if let error, rows.isEmpty { ErrorState(message: error) { Task { await load() } } }
            else if loaded && rows.isEmpty { ContentUnavailableView("No transactions", systemImage: "list.bullet.rectangle") }
        }
        .task { await load() }
    }

    private func query(cursor: String?) -> [String: String] {
        var q = ["limit": "50", "range": drill.range, "type": "expense"]
        if let id = drill.categoryId { q["categoryId"] = id } else { q["uncategorized"] = "1" }
        if let cursor { q["cursor"] = cursor }
        return q
    }

    private func load() async {
        do {
            let page: TxnPage = try await api.get("api/native/transactions", query: query(cursor: nil))
            rows = page.rows
            cursor = page.nextCursor
            error = nil
        } catch APIError.unauthorized {
        } catch { self.error = error.localizedDescription }
        loaded = true
    }

    private func loadMore() async {
        guard let cursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        if let page: TxnPage = try? await api.get("api/native/transactions", query: query(cursor: cursor)) {
            let known = Set(rows.map(\.id))
            rows += page.rows.filter { !known.contains($0.id) }
            self.cursor = page.nextCursor
        }
    }
}

// MARK: Saved reports

struct SavedReport: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let reportType: String
    let dateFrom: String?
    let dateTo: String?

    /// Saved reports keep exact dates (the web app picks them freely). The apps use preset ranges,
    /// so open on the preset that covers the saved span most closely.
    var nearestRange: String {
        guard let from = dateFrom.flatMap(Fmt.date), let to = dateTo.flatMap(Fmt.date) else { return "3M" }
        let days = Calendar.current.dateComponents([.day], from: from, to: to).day ?? 90
        switch days {
        case ..<45: return "1M"
        case ..<135: return "3M"
        case ..<270: return "6M"
        case ..<500: return "1Y"
        default: return "all"
        }
    }
}

/// A toolbar menu for saved reports: open one, save the current report, delete one.
struct SavedReportsMenu: View {
    let tab: ReportTab
    let range: String
    let onOpen: (SavedReport) -> Void
    @EnvironmentObject var api: API
    @State private var reports: [SavedReport] = []
    @State private var naming = false
    @State private var name = ""

    var body: some View {
        Menu {
            if reports.isEmpty { Text("No saved reports") }
            ForEach(reports) { r in
                Button(r.name) { onOpen(r) }
            }
            Divider()
            Button("Save this report…") { name = "\(tab.title) · \(range)"; naming = true }
            if !reports.isEmpty {
                Menu("Delete") {
                    ForEach(reports) { r in
                        Button(r.name, role: .destructive) { Task { await delete(r) } }
                    }
                }
            }
        } label: {
            Image(systemName: "bookmark")
        }
        .accessibilityLabel("Saved reports")
        .task { await load() }
        .alert("Save report", isPresented: $naming) {
            TextField("Name", text: $name)
            Button("Save") { Task { await save() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Saves this report type and range. It also appears in the web app.")
        }
    }

    private func load() async {
        reports = (try? await api.get("api/native/saved-reports")) ?? []
    }

    private func save() async {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        try? await api.post("api/native/saved-reports", body: ["name": trimmed, "reportType": tab.rawValue, "range": range])
        await load()
    }

    private func delete(_ r: SavedReport) async {
        try? await api.delete("api/native/saved-reports/\(r.id)")
        await load()
    }
}
