import SwiftUI
import Charts

struct DashboardView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var connection: Connection
    @State private var data: DashboardResponse?
    @State private var range = "6M"
    @State private var error: String?
    @State private var uncategorized: [Txn] = []
    @State private var uncategorizedMore = false
    @State private var groups: [CategoryGroup] = CategoryCache.groups
    @State private var width: CGFloat = 0
    private let ranges = ["1M", "3M", "6M", "1Y", "all"]

    var body: some View {
        ScrollView {
            if let data {
                VStack(spacing: 16) {
                    netWorth(data)
                    tiles(data.summary)
                    spending(data.spending)
                    feeds(data.recent)
                }
                .padding()
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            } else if let error {
                ErrorState(message: error) { Task { await load() } }
            } else {
                ProgressView().padding(.top, 80)
            }
        }
        .background(Color.canvas)
        .navigationTitle("Dashboard")
        .refreshable { await api.syncBanks(); await load() }
        .task(id: connection.active) { await load() }
        .onChange(of: range) { _, _ in Task { await load() } }
        .onChange(of: api.changedTxn) { _, t in
            guard let t else { return }
            // Show the edit immediately in "Recent", then refresh totals in the background.
            if var d = data, let i = d.recent.firstIndex(where: { $0.id == t.id }) { d.recent[i] = t; data = d }
            // A transaction that now has a category (or became a transfer) leaves "Needs a category".
            if let i = uncategorized.firstIndex(where: { $0.id == t.id }) {
                if t.categoryId != nil || t.isTransfer { uncategorized.remove(at: i) } else { uncategorized[i] = t }
            }
        }
        .task { await loadGroups() }
        .onChange(of: api.dataVersion) { _, _ in Task { await load() } }
    }

    private func load() async {
        do {
            data = try await api.get("api/native/dashboard", query: ["range": range])
            error = nil
            if let page: TxnPage = try? await api.get("api/native/transactions", query: ["uncategorized": "1", "limit": "8"]) {
                // Also filtered here so a server that predates the "uncategorized" filter can't fill the card with everything.
                uncategorized = page.rows.filter { $0.categoryId == nil && !$0.isTransfer }
                uncategorizedMore = page.nextCursor != nil && uncategorized.count == page.rows.count
            }
        } catch APIError.unauthorized {
        } catch {
            if data == nil { self.error = error.localizedDescription }
        }
    }

    private func netWorth(_ d: DashboardResponse) -> some View {
        NetWorthCard(summary: d.summary, history: d.history, range: $range, ranges: ranges)
    }

    private func tiles(_ s: Summary) -> some View {
        HStack(spacing: 12) {
            tile("Income", Fmt.moneyWhole(s.monthlyIncome), Color.income)
            tile("Spending", Fmt.moneyWhole(s.monthlyExpenses), .primary)
            tile("Net", Fmt.moneyWhole(s.monthlyNet), s.monthlyNet < 0 ? .red : Color.income)
        }
    }

    private func tile(_ label: String, _ value: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold).monospacedDigit()).foregroundStyle(color).minimumScaleFactor(0.7).lineLimit(1)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.hairline, lineWidth: 1))
    }

    private func spending(_ rows: [SpendRow]) -> some View {
        let top = Array(rows.sorted { $0.total > $1.total }.prefix(6))
        let maxTotal = Double(top.first?.total ?? 1)
        return Card("Spending this month") {
            if top.isEmpty {
                Text("No spending yet").foregroundStyle(.secondary)
            } else {
                ForEach(top) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(row.categoryName).font(.subheadline)
                            Spacer()
                            Text(Fmt.money(row.total)).font(.subheadline.monospacedDigit())
                        }
                        GeometryReader { geo in
                            Capsule().fill(Color.track)
                                .overlay(alignment: .leading) {
                                    Capsule().fill(Color.accentColor).frame(width: max(6, geo.size.width * Double(row.total) / maxTotal))
                                }
                        }
                        .frame(height: 6)
                    }
                }
            }
        }
    }

    private func loadGroups() async {
        guard groups.isEmpty else { return }
        if let g: [CategoryGroup] = try? await api.get("api/native/categories") {
            groups = g.alphabetical
            CategoryCache.groups = groups
            CategoryStyles.shared.update(g)
        }
    }

    private func quickSetCategory(_ txn: Txn, _ id: String?) {
        Task {
            if let updated: Txn = try? await api.patch("api/native/transactions/\(txn.id)", body: ["categoryId": id ?? NSNull()]) {
                api.noteChanged(updated)
            }
        }
    }

    /// "Needs a category" sits beside "Recent transactions" when there's room, above it otherwise.
    @ViewBuilder
    private func feeds(_ recentRows: [Txn]) -> some View {
        if uncategorized.isEmpty {
            recent(recentRows)
        } else if width >= 760 {
            HStack(alignment: .top, spacing: 16) {
                uncategorizedCard
                recent(recentRows)
            }
        } else {
            uncategorizedCard
            recent(recentRows)
        }
    }

    private var uncategorizedCard: some View {
        Card("Needs a category", trailing: AnyView(
            Text(uncategorizedMore ? "\(uncategorized.count)+" : "\(uncategorized.count)")
                .font(.caption.weight(.semibold)).foregroundStyle(Color.alert)
                .padding(.horizontal, 8).padding(.vertical, 2)
                .background(Color.alert.opacity(0.14), in: Capsule())
        )) {
            ForEach(uncategorized) { txn in
                NavigationLink(value: txn) {
                    TxnRow(txn: txn, groups: groups) { id in quickSetCategory(txn, id) }
                }
                .buttonStyle(.plain)
                if txn.id != uncategorized.last?.id { Divider() }
            }
            if uncategorizedMore {
                Text("Showing the 8 most recent. The rest are in Transactions.").font(.footnote).foregroundStyle(.secondary)
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private func recent(_ rows: [Txn]) -> some View {
        Card("Recent transactions") {
            ForEach(rows) { txn in
                NavigationLink(value: txn) { TxnRow(txn: txn) }.buttonStyle(.plain)
                if txn.id != rows.last?.id { Divider() }
            }
        }
    }
}

/// Net worth headline + chart. Press and drag across the chart to scrub: the headline
/// follows the finger and shows the value and change as of that day.
private struct NetWorthCard: View {
    let summary: Summary
    @Binding var range: String
    let ranges: [String]
    @State private var selectedDate: Date?

    private struct Pt: Identifiable { let id: String; let date: Date; let cents: Int }

    private static let dayFormat: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("EEEMMMdyyyy")
        return f
    }()

    // Computed once per data load, not on every scrub frame.
    private let pts: [Pt]
    private let domain: ClosedRange<Double>

    init(summary: Summary, history: [NetPoint], range: Binding<String>, ranges: [String]) {
        self.summary = summary
        self._range = range
        self.ranges = ranges
        let p = history.compactMap { h in Fmt.date(h.date).map { Pt(id: h.date, date: $0, cents: h.netWorth) } }
        self.pts = p
        self.domain = tightDomain(p.map { Double($0.cents) / 100 })
    }

    /// Binary search: points are date-ascending.
    private func nearest(to date: Date) -> Pt? {
        guard !pts.isEmpty else { return nil }
        var lo = 0, hi = pts.count - 1
        while lo < hi {
            let mid = (lo + hi) / 2
            if pts[mid].date < date { lo = mid + 1 } else { hi = mid }
        }
        if lo > 0, abs(pts[lo - 1].date.timeIntervalSince(date)) < abs(pts[lo].date.timeIntervalSince(date)) { return pts[lo - 1] }
        return pts[lo]
    }

    var body: some View {
        let selected = selectedDate.flatMap(nearest(to:))
        let shownCents = selected?.cents ?? summary.netWorth
        // Change from the start of the range to the shown point.
        let delta: (cents: Int, pct: Double)? = {
            guard let first = pts.first, first.cents != 0 else { return nil }
            let d = shownCents - first.cents
            return (d, Double(d) / Double(abs(first.cents)))
        }()
        Card {
            VStack(alignment: .leading, spacing: 4) {
                Text(selected.map { Self.dayFormat.string(from: $0.date) } ?? "Net worth")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                Text(Fmt.money(shownCents))
                    .font(.system(size: 40, weight: .bold)).monospacedDigit()
                    .tracking(-0.8)
                    .minimumScaleFactor(0.6).lineLimit(1)
                if let delta {
                    HStack(spacing: 6) {
                        Image(systemName: delta.cents >= 0 ? "arrow.up.right" : "arrow.down.right")
                        Text("\(delta.cents >= 0 ? "+" : "−")\(Fmt.moneyWhole(abs(delta.cents)))")
                        Text("(\(abs(delta.pct).formatted(.percent.precision(.fractionLength(1)))))")
                        Text(selected == nil ? "this period" : "since start").foregroundStyle(.secondary).fontWeight(.regular)
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(delta.cents >= 0 ? Color.income : Color.red)
                    .monospacedDigit()
                }
            }
            .transaction { $0.animation = nil } // scrubbing must be 1:1, never animated

            if pts.count > 1 {
                Chart {
                    ForEach(pts) { p in
                        AreaMark(x: .value("Date", p.date), yStart: .value("Floor", domain.lowerBound), yEnd: .value("Net worth", Double(p.cents) / 100))
                            .foregroundStyle(LinearGradient(colors: [Color.accentColor.opacity(0.28), .clear], startPoint: .top, endPoint: .bottom))
                            .interpolationMethod(.monotone)
                        LineMark(x: .value("Date", p.date), y: .value("Net worth", Double(p.cents) / 100))
                            .foregroundStyle(Color.accentColor)
                            .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
                            .interpolationMethod(.monotone)
                    }
                    if let s = selected {
                        RuleMark(x: .value("Date", s.date))
                            .foregroundStyle(.secondary.opacity(0.45))
                            .lineStyle(StrokeStyle(lineWidth: 1))
                        PointMark(x: .value("Date", s.date), y: .value("Net worth", Double(s.cents) / 100))
                            .symbolSize(90)
                            .foregroundStyle(Color.accentColor)
                            .annotation(position: .overlay) {
                                Circle().stroke(Color.card, lineWidth: 2.5).frame(width: 11, height: 11)
                            }
                    }
                }
                .chartXSelection(value: $selectedDate)
                .chartYAxis { AxisMarks(position: .trailing) { AxisValueLabel(format: .currency(code: "USD").notation(.compactName)) } }
                .chartYScale(domain: domain)
                .frame(height: 170)
                .sensoryFeedback(.selection, trigger: selected?.id)
            }
            Picker("Range", selection: $range) {
                ForEach(ranges, id: \.self) { Text($0 == "all" ? "All" : $0).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            HStack(spacing: 16) {
                Label(Fmt.moneyWhole(summary.assets), systemImage: "arrow.up.right").foregroundStyle(Color.income)
                Label(Fmt.moneyWhole(abs(summary.liabilities)), systemImage: "arrow.down.right").foregroundStyle(.red)
                Spacer()
                Text("Assets · Liabilities").font(.caption).foregroundStyle(.tertiary)
            }
            .font(.footnote.weight(.medium))
        }
        .onChange(of: range) { _, _ in selectedDate = nil }
    }
}
