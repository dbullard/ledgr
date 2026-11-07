import SwiftUI
import Charts

/// What the household buys, from itemized receipts: spend by category, then a
/// searchable, sortable list of products that opens each one's price history.
struct ItemsView: View {
    enum Sort: String, CaseIterable, Identifiable {
        case spent = "Most spent", times = "Most bought", avg = "Highest price", last = "Recently bought", name = "Name"
        var id: String { rawValue }
        var symbol: String {
            switch self {
            case .spent: "dollarsign.circle"
            case .times: "number"
            case .avg: "tag"
            case .last: "clock"
            case .name: "textformat"
            }
        }
    }

    @EnvironmentObject var api: API
    @EnvironmentObject var connection: Connection
    @State private var data: ItemsResponse?
    @State private var days = 90
    @State private var category: String?
    @State private var sort = Sort.spent
    @State private var ascending = false
    @State private var query = ""
    @State private var showAllCategories = false
    @State private var error: String?
    @State private var searchTask: Task<Void, Never>?
    private let options = [(30, "30 days"), (90, "90 days"), (365, "1 year"), (3650, "All")]

    private var shownProducts: [Product] {
        guard let data else { return [] }
        // Search runs on the server (name, receipt text, category, store, account, date, price).
        let rows = data.products
        let sorted: [Product]
        switch sort {
        case .spent: sorted = rows.sorted { $0.totalCents > $1.totalCents }
        case .times: sorted = rows.sorted { ($0.purchases, $0.totalCents) > ($1.purchases, $1.totalCents) }
        case .avg: sorted = rows.sorted { $0.avgUnitCents > $1.avgUnitCents }
        case .last: sorted = rows.sorted { ($0.lastDate, $0.totalCents) > ($1.lastDate, $1.totalCents) }
        case .name: sorted = rows.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        }
        // Each sort has a natural direction; `ascending` flips it.
        return (sort == .name) == ascending ? sorted : sorted.reversed()
    }

    var body: some View {
        List {
            Section {
                Picker("Range", selection: $days) {
                    ForEach(options, id: \.0) { Text($0.1).tag($0.0) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            if let data {
                if data.byCategory.isEmpty && category == nil {
                    Section {
                        ContentUnavailableView("No item data yet", systemImage: "cart", description: Text("Attach itemized receipts to see what you buy."))
                    }
                } else {
                    summary(data)
                    categories(data)
                    products()
                }
            } else if let error {
                Section { ErrorState(message: error) { Task { await load() } } }
            } else {
                Section { ProgressView().frame(maxWidth: .infinity) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.canvas)
        .navigationTitle("Items")
        .searchable(text: $query, prompt: "Search name, store, category, month, price")
        .toolbar { ToolbarItem(placement: .primaryAction) { sortMenu } }
        .refreshable { await load() }
        .task(id: connection.active) { await load() }
        .onChange(of: days) { _, _ in Task { await load() } }
        .onChange(of: category) { _, _ in Task { await load() } }
        .onChange(of: query) { _, _ in
            searchTask?.cancel()
            searchTask = Task {
                try? await Task.sleep(nanoseconds: 300_000_000)
                if !Task.isCancelled { await load() }
            }
        }
        .sensoryFeedback(.selection, trigger: sort)
        .sensoryFeedback(.selection, trigger: category)
    }

    // MARK: Sections

    private func summary(_ d: ItemsResponse) -> some View {
        let total = d.byCategory.reduce(0) { $0 + $1.totalCents }
        let count = d.byCategory.reduce(0) { $0 + $1.itemCount }
        return Section {
            HStack(spacing: 10) {
                stat("Spent", Fmt.moneyWhole(total))
                stat("Items", count.formatted())
                stat("Products", d.products.count >= 400 ? "400+" : d.products.count.formatted())
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        } footer: {
            Text("Prices are before tax, so these are lower than the charges they came from.")
        }
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold)).monospacedDigit().minimumScaleFactor(0.7).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func categories(_ d: ItemsResponse) -> some View {
        let total = max(d.byCategory.reduce(0) { $0 + $1.totalCents }, 1)
        let top = max(d.byCategory.map(\.totalCents).max() ?? 1, 1)
        let rows = showAllCategories ? d.byCategory : Array(d.byCategory.prefix(5))
        return Section {
            ForEach(rows) { c in
                let selected = category == c.categoryId && c.categoryId != nil
                Button {
                    withAnimation(.spring(duration: 0.35, bounce: 0)) {
                        category = selected ? nil : c.categoryId
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(c.label).fontWeight(selected ? .semibold : .regular)
                            Spacer()
                            Text(Fmt.moneyWhole(c.totalCents)).monospacedDigit()
                            Text("\(Int((Double(max(c.totalCents, 0)) / Double(total) * 100).rounded()))%")
                                .font(.caption).foregroundStyle(.secondary).monospacedDigit().frame(width: 34, alignment: .trailing)
                        }
                        Capsule().fill(Color.track).frame(height: 6)
                            .overlay(alignment: .leading) {
                                GeometryReader { g in
                                    Capsule().fill(Color.accentColor.gradient)
                                        .frame(width: max(6, g.size.width * Double(max(c.totalCents, 0)) / Double(top)))
                                }
                            }
                    }
                    .padding(.vertical, 2)
                    .opacity(category == nil || selected ? 1 : 0.45)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(c.categoryId == nil)
            }
            if d.byCategory.count > 5 {
                Button(showAllCategories ? "Show fewer" : "Show all \(d.byCategory.count)") {
                    withAnimation(.spring(duration: 0.35, bounce: 0)) { showAllCategories.toggle() }
                }
                .font(.subheadline)
            }
        } header: {
            HStack {
                Text("Spend by category")
                Spacer()
                if category != nil {
                    Button("Clear filter") { withAnimation(.spring(duration: 0.35, bounce: 0)) { category = nil } }
                        .font(.footnote).textCase(nil)
                }
            }
        }
    }

    private func products() -> some View {
        let rows = shownProducts
        return Section {
            if rows.isEmpty {
                Text(query.isEmpty ? "No products in this range." : "No items match “\(query)”.")
                    .foregroundStyle(.secondary)
            }
            ForEach(rows) { p in
                NavigationLink {
                    ProductHistoryView(product: p)
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(p.name).lineLimit(2)
                            Text("\(p.purchases)× · avg \(Fmt.money(p.avgUnitCents)) · last \(Fmt.shortDate(p.lastDate))")
                                .font(.caption).foregroundStyle(.secondary)
                            if let stores = p.storesSummary {
                                Label(stores, systemImage: "storefront")
                                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        Spacer()
                        Text(Fmt.money(p.totalCents)).monospacedDigit()
                    }
                }
            }
        } header: {
            HStack {
                Text("Products · \(rows.count)")
                Spacer()
                Label(sort.rawValue, systemImage: ascending == (sort == .name) ? "arrow.down" : "arrow.up")
                    .labelStyle(.titleAndIcon).font(.footnote).textCase(nil)
            }
        }
    }

    private var sortMenu: some View {
        Menu {
            Picker("Sort by", selection: Binding(get: { sort }, set: { new in
                withAnimation(.spring(duration: 0.35, bounce: 0)) { sort = new; ascending = (new == .name) }
            })) {
                ForEach(Sort.allCases) { Label($0.rawValue, systemImage: $0.symbol).tag($0) }
            }
            Divider()
            Button {
                withAnimation(.spring(duration: 0.35, bounce: 0)) { ascending.toggle() }
            } label: {
                Label("Reverse order", systemImage: "arrow.up.arrow.down")
            }
        } label: {
            Image(systemName: "arrow.up.arrow.down.circle")
        }
        .accessibilityLabel("Sort items")
    }

    // MARK: Loading

    private func load() async {
        let to = Date()
        let from = to.addingTimeInterval(-Double(days) * 86_400)
        var q = ["from": Fmt.iso(from), "to": Fmt.iso(to)]
        if let category { q["category"] = category }
        let term = query.trimmingCharacters(in: .whitespaces)
        if !term.isEmpty { q["q"] = term }
        do {
            data = try await api.get("api/native/items", query: q)
            error = nil
        } catch APIError.unauthorized {
        } catch {
            if data == nil { self.error = error.localizedDescription }
        }
    }
}

/// Every purchase of one product, with its per-unit price over time.
struct ProductHistoryView: View {
    let product: Product
    @EnvironmentObject var api: API
    @State private var points: [PricePoint]?
    @State private var error: String?

    var body: some View {
        List {
            Section {
                HStack(spacing: 10) {
                    stat("Spent", Fmt.money(product.totalCents))
                    stat("Bought", "\(product.purchases)×")
                    stat("Avg", Fmt.money(product.avgUnitCents))
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            if let points, !points.isEmpty {
                Section("Price per unit") {
                    chart(points)
                    if let first = points.first, let last = points.last, points.count > 1 {
                        let delta = last.unitCents - first.unitCents
                        Label(
                            delta == 0 ? "No change since \(Fmt.shortDate(first.date))"
                                : "\(delta > 0 ? "Up" : "Down") \(Fmt.money(abs(delta))) since \(Fmt.shortDate(first.date))",
                            systemImage: delta == 0 ? "equal" : (delta > 0 ? "arrow.up.right" : "arrow.down.right")
                        )
                        .font(.subheadline)
                        .foregroundStyle(delta > 0 ? Color.alert : (delta < 0 ? Color.income : .secondary))
                    }
                }
                Section("Purchases") {
                    ForEach(points.reversed()) { p in
                        if let id = p.transactionId {
                            NavigationLink { TransactionLoader(id: id) } label: { purchaseRow(p) }
                        } else {
                            purchaseRow(p)
                        }
                    }
                }
            } else if let error {
                Section { ErrorState(message: error) { Task { await load() } } }
            } else if points == nil {
                Section { ProgressView().frame(maxWidth: .infinity) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.canvas)
        .navigationTitle(product.name)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task { await load() }
    }

    private func purchaseRow(_ p: PricePoint) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(p.merchant)
                Text([Fmt.shortDate(p.date), p.accountName].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(Fmt.money(p.totalCents)).monospacedDigit()
                Text("\(Fmt.money(p.unitCents)) each").font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
        }
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold)).monospacedDigit().minimumScaleFactor(0.7).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func chart(_ pts: [PricePoint]) -> some View {
        let dated = pts.compactMap { p in Fmt.date(p.date).map { ($0, Double(p.unitCents) / 100) } }
        return Chart {
            ForEach(Array(dated.enumerated()), id: \.offset) { _, d in
                LineMark(x: .value("Date", d.0), y: .value("Price", d.1)).interpolationMethod(.monotone)
                PointMark(x: .value("Date", d.0), y: .value("Price", d.1))
            }
        }
        .tightYScale(dated.map(\.1))
        .chartYAxis { AxisMarks { AxisValueLabel(format: .currency(code: "USD")) } }
        .foregroundStyle(Color.accentColor)
        .frame(height: 160)
        .padding(.vertical, 6)
    }

    private func load() async {
        do {
            points = try await api.get("api/native/items/history", query: ["key": product.key])
            error = nil
        } catch APIError.unauthorized {
        } catch {
            if points == nil { self.error = error.localizedDescription }
        }
    }
}

/// Opens a transaction by id (the purchase list only knows the id, not the full row).
struct TransactionLoader: View {
    let id: String
    @EnvironmentObject var api: API
    @State private var txn: Txn?
    @State private var error: String?

    var body: some View {
        Group {
            if let txn {
                TransactionDetailView(initial: txn)
            } else if let error {
                ErrorState(message: error) { Task { await load() } }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            let d: TxnDetail = try await api.get("api/native/transactions/\(id)")
            txn = d.txn
            error = nil
        } catch APIError.unauthorized {
        } catch {
            if txn == nil { self.error = error.localizedDescription }
        }
    }
}
