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
    @State private var dropMessage: String?
    @ObservedObject private var suggester = CategorySuggester.shared

    private struct Key: Hashable { let search: String; let filter: TxnFilter; let base: URL? }

    var body: some View {
        List {
            ForEach(sections, id: \.0) { header, items in
                Section(header) {
                    ForEach(items) { txn in
                        NavigationLink(value: txn) { TxnRow(txn: txn, suggestion: suggester.suggestions[txn.id]) }
                            .receiptDropTarget(transactionId: txn.id, inset: 4) { dropMessage = $0 }
                            .listRowBackground(Color.card)
                            .onAppear {
                                suggester.enqueue(txn, api: api)
                                if txn.id == rows.last?.id { Task { await loadMore() } }
                            }
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
        .overlay(alignment: .bottom) {
            if let dropMessage {
                Text(dropMessage)
                    .font(.subheadline.weight(.medium))
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.bottom, 20)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task { try? await Task.sleep(for: .seconds(2.5)); self.dropMessage = nil }
            }
        }
        .animation(.snappy, value: dropMessage)
        .onChange(of: api.changedTxn) { _, t in
            guard let t, let i = rows.firstIndex(where: { $0.id == t.id }) else { return }
            if filter == .needsReview && t.reviewed { rows.remove(at: i) } else { rows[i] = t }
        }
        .refreshable { await api.syncBanks(); await reload() }
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
    @State private var groups: [CategoryGroup] = CategoryCache.groups
    @State private var loadingCategories = false
    @State private var categoriesFailed = false
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
    @State private var showCategories = false
    @State private var receiptToDelete: ReceiptSummary?
    @ObservedObject private var suggester = CategorySuggester.shared

    private var txn: Txn { detail?.txn ?? initial }
    private var suggested: Category? { suggester.suggestions[txn.id] }
    private var suggesting: Bool { txn.categoryName == nil && !suggester.isKnown(txn.id) }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                hero
                if !txn.isTransfer { reviewButton }

                Card {
                    categoryRow
                    suggestionRow
                    Divider()
                    TextField("Add a note", text: $notes, axis: .vertical)
                        .textFieldStyle(.plain)
                        .lineLimit(1...6)
                        .focused($notesFocused)
                        .onChange(of: notesFocused) { _, focused in if !focused { Task { await saveNotes() } } }
                        .onSubmit { Task { await saveNotes() } }
                }

                Card("Details") {
                    detailRow("Account", txn.accountName)
                    Divider()
                    detailRow("Date", Fmt.dayHeader(txn.date))
                    if let merchant = txn.merchantName, merchant != txn.name {
                        Divider()
                        detailRow("Merchant", merchant)
                    }
                    Divider()
                    detailRow("Status", txn.pending ? "Pending" : "Posted", valueColor: txn.pending ? Color.alert : nil)
                }

                if let detail, !detail.splits.isEmpty {
                    Card("Splits") {
                        ForEach(Array(detail.splits.enumerated()), id: \.element.id) { i, s in
                            if i > 0 { Divider() }
                            detailRow(s.categoryName ?? "Uncategorized", Fmt.money(s.amount))
                        }
                    }
                }

                if let detail, !detail.items.isEmpty {
                    Card("Items · \(detail.items.count)") {
                        ForEach(Array(detail.items.enumerated()), id: \.element.id) { i, it in
                            if i > 0 { Divider() }
                            HStack(alignment: .top, spacing: 12) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(it.name).lineLimit(2)
                                    let sub = [it.categoryName, it.quantityMilli == 1000 ? nil : "×\(Fmt.quantity(it.quantityMilli))"]
                                        .compactMap { $0 }.joined(separator: " · ")
                                    if !sub.isEmpty { Text(sub).font(.caption).foregroundStyle(.secondary) }
                                }
                                Spacer(minLength: 8)
                                Text(Fmt.money(it.totalCents)).monospacedDigit()
                            }
                        }
                        Divider()
                        detailRow("Items total", Fmt.money(detail.itemsTotalCents))
                        if let gap = detail.itemsGapCents, gap != 0 {
                            Text(gap > 0 ? "\(Fmt.money(gap)) more is tax or fees." : "\(Fmt.money(-gap)) less than the lines. Check for a missed discount.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }

                Card("Receipts") {
                    if let detail, !detail.receipts.isEmpty {
                        ForEach(detail.receipts) { r in
                          HStack(spacing: 6) {
                            Button { Task { await open(r) } } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: r.contentType == "application/pdf" ? "doc.richtext" : "photo")
                                        .font(.body.weight(.medium))
                                        .foregroundStyle(Color.accentColor)
                                        .frame(width: 34, height: 34)
                                        .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(r.originalFilename).lineLimit(1).foregroundStyle(Color.primary)
                                        Text(Fmt.bytes(r.sizeBytes)).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if opening == r.id { ProgressView().controlSize(.small) }
                                    else { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary) }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            Menu {
                                Button { Task { await detach(r) } } label: { Label("Remove from transaction", systemImage: "link.badge.plus") }
                                Button(role: .destructive) { receiptToDelete = r } label: { Label("Delete receipt…", systemImage: "trash") }
                            } label: {
                                Image(systemName: "ellipsis.circle").font(.body).foregroundStyle(.secondary).frame(width: 28, height: 28).contentShape(Rectangle())
                            }
                            .menuStyle(.borderlessButton)
                            .menuIndicator(.hidden)
                            .fixedSize()
                            .accessibilityLabel("Receipt actions")
                          }
                            Divider()
                        }
                    } else {
                        Text("No receipt yet. Attach a photo, scan or PDF.")
                            .font(.footnote).foregroundStyle(.secondary)
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
                        HStack(spacing: 8) {
                            if attaching { ProgressView().controlSize(.small) } else { Image(systemName: "plus.circle.fill") }
                            Text(detail?.receipts.isEmpty == false ? "Add another receipt" : "Add receipt")
                            Spacer()
                        }
                        .foregroundStyle(Color.accentColor)
                        .contentShape(Rectangle())
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .disabled(attaching)
                }

                if let error {
                    Text(error).foregroundStyle(.red).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding()
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
        }
        .background(Color.canvas)
        .receiptDropTarget(transactionId: initial.id, inset: -8) { msg in
            if msg.hasPrefix("Receipt") || msg.hasSuffix("attached") { error = nil; Task { await load() } } else { error = msg }
        }
        .navigationTitle("")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .onDisappear { Task { await saveNotes() } }
        .quickLookPreview($preview)
        .confirmationDialog(
            "Delete this receipt?",
            isPresented: Binding(get: { receiptToDelete != nil }, set: { if !$0 { receiptToDelete = nil } }),
            titleVisibility: .visible,
            presenting: receiptToDelete
        ) { r in
            Button("Delete \(r.originalFilename)", role: .destructive) { Task { await deleteReceipt(r) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("The file is removed permanently. The transaction is not changed.")
        }
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
            async let cats: Void = loadCategories()
            await load()
            await cats
            suggester.enqueue(txn, api: api)
        }
    }

    private var hero: some View {
        Card {
            VStack(spacing: 10) {
                CategoryBadge(icon: txn.isTransfer ? "arrow-left-right" : txn.categoryIcon, size: 64)
                Text(txn.name)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                Text(Fmt.money(txn.normalizedAmount))
                    .font(.system(size: 44, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                    .tracking(-0.5)
                    .foregroundStyle(txn.normalizedAmount > 0 ? Color.income : Color.primary)
                    .contentTransition(.numericText())
                HStack(spacing: 6) {
                    if txn.pending { chip("Pending", Color.alert) }
                    if txn.isTransfer { chip("Transfer", .secondary) }
                    else if !txn.reviewed { chip("Needs review", Color.accentColor) }
                }
                Text("\(Fmt.dayHeader(txn.date)) · \(txn.accountName)")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
    }

    private func detailRow(_ label: String, _ value: String, valueColor: Color? = nil) -> some View {
        HStack {
            Text(label).foregroundStyle(Color.primary)
            Spacer(minLength: 16)
            Text(value).foregroundStyle(valueColor ?? Color.secondary).multilineTextAlignment(.trailing).monospacedDigit()
        }
    }

    private func chip(_ text: String, _ color: Color) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 9).padding(.vertical, 3)
            .background(color.opacity(0.14), in: Capsule())
    }

    private var reviewButton: some View {
        Button { Task { await setReviewed(!txn.reviewed) } } label: {
            HStack(spacing: 8) {
                Image(systemName: txn.reviewed ? "checkmark.circle.fill" : "circle")
                Text(txn.reviewed ? "Reviewed" : "Mark as reviewed")
                if txn.reviewed { Spacer(); Text("Undo").font(.subheadline).opacity(0.8) }
            }
            .font(.body.weight(.semibold))
            .foregroundStyle(txn.reviewed ? Color.white : Color.accentColor)
            .frame(maxWidth: .infinity, minHeight: 44)
            .padding(.horizontal, txn.reviewed ? 16 : 0)
            .background(txn.reviewed ? Color.income : Color.clear, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(txn.reviewed ? Color.clear : Color.accentColor, lineWidth: 1.5)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.success, trigger: txn.reviewed)
        .animation(.snappy(duration: 0.2), value: txn.reviewed)
    }

    private var categoryRow: some View {
        Button {
            showCategories = true
            if groups.isEmpty { Task { await loadCategories() } }
        } label: {
            HStack(spacing: 8) {
                Text("Category").foregroundStyle(Color.primary)
                Spacer(minLength: 12)
                HStack(spacing: 6) {
                    if txn.categoryName == nil, suggested != nil { Image(systemName: "sparkles").foregroundStyle(Color.accentColor) }
                    Text(txn.categoryName ?? suggested?.name ?? "Choose…")
                        .fontWeight(.medium)
                        .foregroundStyle(txn.categoryName == nil ? (suggested == nil ? Color.alert : Color.accentColor) : Color.primary)
                    Image(systemName: "chevron.up.chevron.down").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background((txn.categoryName == nil ? (suggested == nil ? Color.alert : Color.accentColor) : Color.primary).opacity(0.1), in: Capsule())
            }
            .frame(maxWidth: .infinity, minHeight: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showCategories, arrowEdge: .bottom) {
            CategoryPicker(groups: groups, currentId: txn.categoryId, loading: loadingCategories, failed: categoriesFailed, retry: { Task { await loadCategories() } }) { id in
                showCategories = false
                Task { await setCategory(id) }
            }
        }
    }

    /// The on-device suggestion shows as a sparkle pill above until you confirm or dismiss it.
    @ViewBuilder private var suggestionRow: some View {
        if txn.categoryName == nil, !txn.isTransfer, OnDeviceAI.isAvailable {
            HStack(spacing: 12) {
                if let c = suggested {
                    Button { Task { await setCategory(c.id) } } label: {
                        Label("Confirm", systemImage: "checkmark")
                    }
                    Button("Dismiss") { suggester.resolve(txn.id, api: api) }.foregroundStyle(.secondary)
                } else if suggesting {
                    ProgressView().controlSize(.small)
                    Text("Suggesting…").foregroundStyle(.secondary)
                }
                Spacer()
                Label("AI · on device", systemImage: "lock.fill").font(.caption).foregroundStyle(.secondary)
            }
            .font(.subheadline)
        }
    }

    private func detach(_ r: ReceiptSummary) async {
        do {
            try await api.post("api/native/receipts/\(r.id)/detach", body: [:])
            error = nil
            await load()
        } catch APIError.unauthorized {
        } catch { self.error = error.localizedDescription }
    }

    private func deleteReceipt(_ r: ReceiptSummary) async {
        do {
            try await api.delete("api/native/receipts/\(r.id)")
            error = nil
            await load()
        } catch APIError.unauthorized {
        } catch { self.error = error.localizedDescription }
    }

    private func load() async {
        if let d: TxnDetail = try? await api.get("api/native/transactions/\(initial.id)") {
            detail = d
            notes = d.txn.notes ?? ""
        }
    }

    private func loadCategories() async {
        guard !loadingCategories else { return }
        loadingCategories = true
        defer { loadingCategories = false }
        do {
            let g: [CategoryGroup] = try await api.get("api/native/categories")
            groups = g
            CategoryCache.groups = g
            categoriesFailed = false
        } catch APIError.unauthorized {
        } catch { categoriesFailed = true }
    }

    private func patch(_ body: [String: Any]) async {
        do {
            let updated: Txn = try await api.patch("api/native/transactions/\(initial.id)", body: body)
            if let d = detail { detail = TxnDetail(txn: updated, splits: d.splits, receipts: d.receipts, items: d.items, itemsTotalCents: d.itemsTotalCents, itemsGapCents: d.itemsGapCents) }
            else { await load() }
            error = nil
        } catch APIError.unauthorized {
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func setCategory(_ id: String?) async {
        suggester.resolve(txn.id, api: api)
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
            var fields: [String: String] = [:]
            if let parsed = await ReceiptReader.parsedJSON(data: data, filename: filename) { fields["parsed"] = parsed }
            _ = try await api.upload("api/native/transactions/\(initial.id)/receipts", fields: fields, file: data, filename: filename)
            await api.fillNoteIfNeeded(transactionId: initial.id, data: data, filename: filename)
            error = nil
            await load()
            api.noteChanged()
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

@MainActor
enum CategoryCache { static var groups: [CategoryGroup] = [] }

/// Searchable category dropdown, grouped, with the current choice checked.
struct CategoryPicker: View {
    let groups: [CategoryGroup]
    let currentId: String?
    var loading = false
    var failed = false
    var retry: () -> Void = {}
    let onPick: (String?) -> Void
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    private var filtered: [CategoryGroup] {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return groups }
        return groups.compactMap { g in
            let cats = g.categories.filter { $0.name.localizedCaseInsensitiveContains(q) }
            return cats.isEmpty ? nil : CategoryGroup(id: g.id, name: g.name, icon: g.icon, isSystem: g.isSystem, categories: cats)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search categories", text: $query)
                    .textFieldStyle(.plain)
                    .focused($searchFocused)
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary) }
                        .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: []) {
                    if groups.isEmpty && loading {
                        ProgressView().frame(maxWidth: .infinity).padding(32)
                    } else if groups.isEmpty && failed {
                        VStack(spacing: 8) {
                            Text("Couldn't load categories").foregroundStyle(.secondary)
                            Button("Try again", action: retry)
                        }
                        .frame(maxWidth: .infinity).padding(24)
                    }
                    if query.isEmpty { row(nil, "Uncategorized", icon: nil) }
                    ForEach(filtered) { g in
                        Text(g.name.uppercased())
                            .font(.caption2.weight(.semibold)).tracking(0.6)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 4)
                        ForEach(g.categories) { c in row(c.id, c.name, icon: c.icon) }
                    }
                    if filtered.isEmpty && !groups.isEmpty {
                        Text("No matches").foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(24)
                    }
                }
                .padding(.bottom, 8)
            }
        }
        .frame(minWidth: 280, idealWidth: 300, minHeight: 320, idealHeight: 420, maxHeight: 460)
        .presentationDetents([.medium, .large])
        .onAppear { searchFocused = true }
    }

    private func row(_ id: String?, _ name: String, icon: String?) -> some View {
        Button { onPick(id) } label: {
            HStack(spacing: 10) {
                CategoryBadge(icon: icon, size: 26)
                Text(name).foregroundStyle(Color.primary)
                Spacer()
                if id == currentId { Image(systemName: "checkmark").font(.footnote.weight(.bold)).foregroundStyle(Color.accentColor) }
            }
            .padding(.horizontal, 14).padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

extension TxnDetail {
    init(txn: Txn, splits: [SplitRow], receipts: [ReceiptSummary], items: [TxnItem] = [], itemsTotalCents: Int = 0, itemsGapCents: Int? = nil) {
        self.txn = txn
        self.splits = splits
        self.receipts = receipts
        self.items = items
        self.itemsTotalCents = itemsTotalCents
        self.itemsGapCents = itemsGapCents
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
