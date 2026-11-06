import SwiftUI
import QuickLook

enum TxnFilter: String, CaseIterable, Identifiable {
    case all = "All", needsReview = "Needs review", expense = "Spending", credits = "Income"
    var id: String { rawValue }
}

struct TransactionsView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var connection: Connection
    @State private var rows: [Txn] = []
    @State private var cursor: String?
    @State private var loaded = false
    @State private var loadingMore = false
    @State private var error: String?
    @State private var search = ""
    @State private var filter: TxnFilter = .all

    private struct Key: Hashable { let search: String; let filter: TxnFilter; let base: URL? }

    var body: some View {
        List {
            ForEach(sections, id: \.0) { header, items in
                Section(header) {
                    ForEach(items) { txn in
                        NavigationLink(value: txn) { TxnRow(txn: txn) }
                            .listRowBackground(Color.card)
                            .onAppear { if txn.id == rows.last?.id { Task { await loadMore() } } }
                    }
                }
            }
            if loadingMore { ProgressView().frame(maxWidth: .infinity) }
        }
        .scrollContentBackground(.hidden)
        .background(Color.canvas)
        .overlay {
            if !loaded && error == nil { ProgressView() }
            else if let error, rows.isEmpty { ErrorState(message: error) { Task { await reload() } } }
            else if loaded && rows.isEmpty { ContentUnavailableView("No transactions", systemImage: "list.bullet.rectangle", description: Text(search.isEmpty ? "Nothing matches this filter." : "No results for “\(search)”.")) }
        }
        .navigationTitle("Transactions")
        .searchable(text: $search, prompt: "Search transactions")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Picker("Filter", selection: $filter) {
                        ForEach(TxnFilter.allCases) { Text($0.rawValue).tag($0) }
                    }
                } label: {
                    Image(systemName: filter == .all ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                }
            }
        }
        .refreshable { await reload() }
        .task(id: Key(search: search, filter: filter, base: connection.active)) {
            if !search.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
            guard !Task.isCancelled else { return }
            await reload()
        }
    }

    private var sections: [(String, [Txn])] {
        var out: [(String, [Txn])] = []
        for txn in rows {
            let header = Fmt.dayHeader(txn.date)
            if let last = out.last, last.0 == header { out[out.count - 1].1.append(txn) }
            else { out.append((header, [txn])) }
        }
        return out
    }

    private func query(cursor: String?) -> [String: String] {
        var q = ["limit": "40"]
        if !search.isEmpty { q["search"] = search }
        switch filter {
        case .all: break
        case .needsReview: q["needsReview"] = "1"
        case .expense: q["type"] = "expense"
        case .credits: q["type"] = "credits"
        }
        if let cursor { q["cursor"] = cursor }
        return q
    }

    private func reload() async {
        do {
            let page: TxnPage = try await api.get("api/native/transactions", query: query(cursor: nil))
            rows = page.rows
            cursor = page.nextCursor
            error = nil
            loaded = true
        } catch APIError.unauthorized {
        } catch {
            self.error = error.localizedDescription
            loaded = true
        }
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

struct TransactionDetailView: View {
    let initial: Txn
    @EnvironmentObject var api: API
    @State private var detail: TxnDetail?
    @State private var groups: [CategoryGroup] = []
    @State private var notes = ""
    @State private var error: String?
    @State private var preview: URL?
    @State private var opening: String?
    @FocusState private var notesFocused: Bool

    private var txn: Txn { detail?.txn ?? initial }

    var body: some View {
        List {
            Section {
                VStack(spacing: 6) {
                    CategoryBadge(icon: txn.isTransfer ? "arrow-left-right" : txn.categoryIcon, size: 56)
                    Text(txn.name).font(.title3.weight(.semibold)).multilineTextAlignment(.center)
                    Text(Fmt.money(txn.normalizedAmount))
                        .font(.system(size: 34, weight: .bold, design: .rounded)).monospacedDigit()
                        .foregroundStyle(txn.normalizedAmount > 0 ? Color.income : Color.primary)
                    Text("\(Fmt.dayHeader(txn.date)) · \(txn.accountName)").font(.footnote).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
            }

            Section {
                Menu {
                    Button("Uncategorized") { Task { await setCategory(nil) } }
                    ForEach(groups) { group in
                        Section(group.name) {
                            ForEach(group.categories) { cat in
                                Button { Task { await setCategory(cat.id) } } label: {
                                    Label(cat.name, systemImage: Icons.symbol(cat.icon))
                                }
                            }
                        }
                    }
                } label: {
                    LabeledContent("Category") {
                        HStack(spacing: 4) {
                            Text(txn.categoryName ?? "Uncategorized").foregroundStyle(txn.categoryName == nil ? .orange : .secondary)
                            Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                }
                .tint(.primary)
                Toggle("Reviewed", isOn: Binding(get: { txn.reviewed }, set: { v in Task { await setReviewed(v) } }))
                TextField("Add a note", text: $notes, axis: .vertical)
                    .focused($notesFocused)
                    .onChange(of: notesFocused) { _, focused in if !focused { Task { await saveNotes() } } }
            }

            if let detail, !detail.splits.isEmpty {
                Section("Splits") {
                    ForEach(detail.splits) { s in
                        LabeledContent(s.categoryName ?? "Uncategorized", value: Fmt.money(s.amount))
                    }
                }
            }

            Section {
                if let detail, !detail.receipts.isEmpty {
                    ForEach(detail.receipts) { r in
                        Button { Task { await open(r) } } label: {
                            HStack {
                                Image(systemName: r.contentType == "application/pdf" ? "doc.richtext" : "doc.text.image")
                                VStack(alignment: .leading) {
                                    Text(r.originalFilename).lineLimit(1)
                                    Text(Fmt.bytes(r.sizeBytes)).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if opening == r.id { ProgressView() }
                            }
                        }
                        .tint(.primary)
                    }
                } else {
                    Text("No receipt. Optional — add one from the Receipts tab.").font(.footnote).foregroundStyle(.secondary)
                }
            } header: { Text("Receipts") }

            if let error {
                Section { Text(error).foregroundStyle(.red).font(.footnote) }
            }
        }
        .navigationTitle("")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .quickLookPreview($preview)
        .task {
            notes = initial.notes ?? ""
            await load()
        }
    }

    private func load() async {
        if let d: TxnDetail = try? await api.get("api/native/transactions/\(initial.id)") {
            detail = d
            notes = d.txn.notes ?? ""
        }
        if groups.isEmpty, let g: [CategoryGroup] = try? await api.get("api/native/categories") { groups = g }
    }

    private func patch(_ body: [String: Any]) async {
        do {
            let updated: Txn = try await api.patch("api/native/transactions/\(initial.id)", body: body)
            if let d = detail { detail = TxnDetail(txn: updated, splits: d.splits, receipts: d.receipts) }
            else { await load() }
            error = nil
        } catch APIError.unauthorized {
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func setCategory(_ id: String?) async {
        let value: Any = id ?? NSNull()
        await patch(["categoryId": value])
    }
    private func setReviewed(_ value: Bool) async { await patch(["reviewed": value]) }

    private func saveNotes() async {
        let trimmed = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed != (txn.notes ?? "") else { return }
        await patch(["notes": trimmed])
    }

    private func open(_ r: ReceiptSummary) async {
        opening = r.id
        defer { opening = nil }
        do { preview = try await api.downloadReceipt(r) }
        catch { self.error = error.localizedDescription }
    }
}

extension TxnDetail {
    init(txn: Txn, splits: [SplitRow], receipts: [ReceiptSummary]) {
        self.txn = txn
        self.splits = splits
        self.receipts = receipts
    }
}
