import SwiftUI
import QuickLook
import PhotosUI
import UniformTypeIdentifiers

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
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showScan = false
    @State private var showWaiting = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var attaching = false

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
                    Text("No receipt yet. Optional.").font(.footnote).foregroundStyle(.secondary)
                }
                Menu {
                    #if os(iOS)
                    if DocumentScanner.isAvailable {
                        Button { showScan = true } label: { Label("Scan receipt", systemImage: "doc.viewfinder") }
                    }
                    #endif
                    Button { showPhotos = true } label: { Label("Choose photo", systemImage: "photo") }
                    Button { showFiles = true } label: { Label("Choose file…", systemImage: "folder") }
                    Button { showWaiting = true } label: { Label("From waiting receipts…", systemImage: "tray") }
                } label: {
                    HStack {
                        if attaching { ProgressView().controlSize(.small) }
                        Label("Add receipt", systemImage: "paperclip")
                    }
                }
                .disabled(attaching)
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
        .photosPicker(isPresented: $showPhotos, selection: $photoItems, matching: .images)
        .fileImporter(isPresented: $showFiles, allowedContentTypes: RootView.receiptTypes, allowsMultipleSelection: true) { result in
            if case .success(let urls) = result {
                Task {
                    for url in urls {
                        let scoped = url.startAccessingSecurityScopedResource()
                        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                        if let data = try? Data(contentsOf: url) { await attach(data, url.lastPathComponent) }
                    }
                }
            }
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            Task {
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        await attach(ImageTools.jpegData(fromImageData: data) ?? data, "photo-\(UploadQueue.stamp()).jpg")
                    }
                }
                photoItems = []
            }
        }
        #if os(iOS)
        .fullScreenCover(isPresented: $showScan) {
            DocumentScanner { pages in
                if let file = ImageTools.receiptFile(fromScans: pages) {
                    Task { await attach(file.data, "scan-\(UploadQueue.stamp()).\(file.ext)") }
                }
            }
            .ignoresSafeArea()
        }
        #endif
        .sheet(isPresented: $showWaiting) {
            WaitingReceiptPicker(transactionId: initial.id) { await load() }
                #if os(macOS)
                .frame(minWidth: 420, minHeight: 360)
                #endif
        }
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

    /// Uploads straight onto this transaction (no matching step).
    private func attach(_ data: Data, _ filename: String) async {
        attaching = true
        defer { attaching = false }
        do {
            _ = try await api.upload("api/native/transactions/\(initial.id)/receipts", fields: [:], file: data, filename: filename)
            error = nil
            await load()
        } catch APIError.unauthorized {
        } catch { self.error = error.localizedDescription }
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

/// Pick a receipt that was uploaded without a transaction and attach it here.
struct WaitingReceiptPicker: View {
    let transactionId: String
    let onDone: () async -> Void
    @EnvironmentObject var api: API
    @Environment(\.dismiss) private var dismiss
    @State private var waiting: [UnmatchedReceipt]?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if let waiting {
                    if waiting.isEmpty { Text("No receipts are waiting.").foregroundStyle(.secondary) }
                    ForEach(waiting) { r in
                        Button { Task { await attach(r) } } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(r.hintMerchant ?? r.originalFilename).font(.body.weight(.medium)).lineLimit(1)
                                Text([r.hintTotalCents.map { Fmt.money($0) }, r.hintDate.map { Fmt.shortDate($0) }].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .tint(.primary)
                    }
                } else { ProgressView() }
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
            }
            .navigationTitle("Waiting receipts")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task {
                if let list: [UnmatchedReceipt] = try? await api.get("api/native/receipts") { waiting = list } else { waiting = [] }
            }
        }
    }

    private func attach(_ r: UnmatchedReceipt) async {
        do {
            try await api.post("api/native/receipts/attach", body: ["receiptId": r.id, "transactionId": transactionId])
            await onDone()
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
