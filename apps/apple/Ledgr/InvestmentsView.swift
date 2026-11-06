import SwiftUI
import Charts

struct PortfolioSummaryModel: Codable {
    let totalValue: Int
    let holdingsValue: Int
    let cashValue: Int
    let dayChange: Int?
    let totalGainLoss: Int
    let totalCostBasis: Int
    let gainLossCoverage: Int
}

struct PortfolioPointModel: Codable, Identifiable {
    let date: String
    let value: Int
    var id: String { date }
}

struct AllocationSliceModel: Codable, Identifiable {
    let type: String
    let value: Int
    let percentage: Double
    var id: String { type }
}

struct ReconciliationModel: Codable, Identifiable {
    let accountId: String
    let accountName: String
    let balance: Int
    let holdingsValue: Int
    let cashValue: Int
    let hasHoldings: Bool
    var id: String { accountId }
}

struct GrowthModel: Codable {
    let since: String
    let startValue: Int
    let endValue: Int
    let netContributions: Int
    let growth: Int
}

struct InvestmentsOverview: Codable {
    let summary: PortfolioSummaryModel
    let history: [PortfolioPointModel]
    let allocation: [AllocationSliceModel]
    let reconciliation: [ReconciliationModel]
    let growth: GrowthModel?
}

struct HoldingModel: Codable, Identifiable {
    let ticker: String?
    let securityName: String
    let type: String?
    let sector: String?
    let quantity: Double
    let currentValue: Int
    let costBasis: Int?
    let gainLoss: Int?
    let gainLossPercent: Double?
    let accountName: String?
    var id: String { "\(ticker ?? securityName)|\(accountName ?? "")" }
}

struct InvTxnModel: Codable, Identifiable {
    let id: String
    let date: String
    let type: String?
    let securityName: String?
    let ticker: String?
    let quantity: Double?
    let price: Int?
    let amount: Int
    let fees: Int?
    let accountName: String
}

struct InvTxnPageModel: Codable {
    let rows: [InvTxnModel]
    let nextCursor: String?
}

private func pct(_ v: Double?) -> String {
    guard let v else { return "" }
    return String(format: "%@%.1f%%", v >= 0 ? "+" : "", v)
}

struct InvestmentsView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var connection: Connection
    @State private var tab = 0
    @State private var range = "1Y"
    @State private var overview: InvestmentsOverview?
    @State private var holdings: [HoldingModel]?
    @State private var byAccount = false
    @State private var txns: [InvTxnModel] = []
    @State private var nextCursor: String?
    @State private var txnsLoaded = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Picker("View", selection: $tab) {
                    Text("Overview").tag(0)
                    Text("Holdings").tag(1)
                    Text("Activity").tag(2)
                }
                .pickerStyle(.segmented)
                if let error, overview == nil {
                    ErrorState(message: error) { Task { await loadOverview() } }
                } else if tab == 0 { overviewTab }
                else if tab == 1 { holdingsTab }
                else { activityTab }
            }
            .padding()
        }
        .background(Color.canvas)
        .navigationTitle("Investments")
        .refreshable { await reload() }
        .task(id: connection.active) { await reload() }
        .task(id: range) { await loadOverview() }
        .task(id: byAccount) { await loadHoldings() }
        .task(id: tab) { if tab == 2 && !txnsLoaded { await loadTxns(reset: true) } }
    }

    // MARK: Overview

    @ViewBuilder private var overviewTab: some View {
        if let o = overview {
            let s = o.summary
            Card {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Portfolio value").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    Text(Fmt.money(s.totalValue)).font(.system(size: 36, weight: .bold)).monospacedDigit().minimumScaleFactor(0.6).lineLimit(1)
                    HStack(spacing: 14) {
                        if let day = s.dayChange {
                            Label("\(day >= 0 ? "+" : "-")\(Fmt.moneyWhole(abs(day))) today", systemImage: day >= 0 ? "arrow.up.right" : "arrow.down.right")
                                .foregroundStyle(day >= 0 ? Color.income : .red)
                        }
                        if s.totalCostBasis > 0 {
                            Text("\(s.totalGainLoss >= 0 ? "+" : "-")\(Fmt.moneyWhole(abs(s.totalGainLoss))) all-time")
                                .foregroundStyle(s.totalGainLoss >= 0 ? Color.income : .red)
                        }
                    }
                    .font(.footnote.weight(.medium))
                }
                if o.history.count > 1 {
                    Chart(o.history) { p in
                        if let d = Fmt.date(p.date) {
                            AreaMark(x: .value("Date", d), yStart: .value("Floor", tightDomain(o.history.map { Double($0.value) / 100 }).lowerBound), yEnd: .value("Value", Double(p.value) / 100))
                                .foregroundStyle(LinearGradient(colors: [Color.accentColor.opacity(0.3), .clear], startPoint: .top, endPoint: .bottom))
                            LineMark(x: .value("Date", d), y: .value("Value", Double(p.value) / 100))
                                .foregroundStyle(Color.accentColor).interpolationMethod(.monotone)
                        }
                    }
                    .chartYAxis { AxisMarks(position: .trailing) { AxisValueLabel(format: .currency(code: "USD").notation(.compactName)) } }
                    .tightYScale(o.history.map { Double($0.value) / 100 })
                    .frame(height: 150)
                }
                Picker("Range", selection: $range) {
                    ForEach(["1M", "3M", "6M", "1Y", "all"], id: \.self) { Text($0 == "all" ? "All" : $0).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            if let g = o.growth {
                Card("Growth since \(Fmt.shortDate(g.since))") {
                    HStack {
                        stat("Contributed", Fmt.moneyWhole(g.netContributions))
                        stat("Market growth", "\(g.growth >= 0 ? "+" : "-")\(Fmt.moneyWhole(abs(g.growth)))", g.growth >= 0 ? Color.income : .red)
                    }
                    Text("Growth is an estimate: the rise in value beyond money you added.").font(.caption).foregroundStyle(.secondary)
                }
            }
            if !o.allocation.isEmpty {
                Card("Allocation") {
                    Chart(o.allocation) { a in
                        SectorMark(angle: .value("Value", a.value), innerRadius: .ratio(0.6), angularInset: 1)
                            .foregroundStyle(by: .value("Type", a.type.capitalized))
                    }
                    .frame(height: 160)
                    ForEach(o.allocation) { a in
                        HStack {
                            Text(a.type.capitalized)
                            Spacer()
                            Text(Fmt.moneyWhole(a.value)).monospacedDigit()
                            Text(String(format: "%.0f%%", a.percentage)).foregroundStyle(.secondary).frame(width: 44, alignment: .trailing)
                        }
                        .font(.subheadline)
                    }
                }
            }
            if !o.reconciliation.isEmpty {
                Card("Accounts") {
                    ForEach(o.reconciliation) { r in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(r.accountName).font(.body.weight(.medium))
                                Spacer()
                                Text(Fmt.money(r.balance)).font(.body.monospacedDigit())
                            }
                            Text(r.hasHoldings ? "Holdings \(Fmt.moneyWhole(r.holdingsValue)) · Cash \(Fmt.moneyWhole(r.cashValue))" : "Balance only (no holdings reported)")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if r.id != o.reconciliation.last?.id { Divider() }
                    }
                }
            }
        } else {
            ProgressView().padding(.top, 60)
        }
    }

    private func stat(_ label: String, _ value: String, _ color: Color = .primary) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold).monospacedDigit()).foregroundStyle(color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Holdings

    @ViewBuilder private var holdingsTab: some View {
        Picker("Group", selection: $byAccount) {
            Text("Combined").tag(false)
            Text("By account").tag(true)
        }
        .pickerStyle(.segmented)
        if let holdings {
            Card("Holdings", trailing: AnyView(Text("\(holdings.count)").font(.footnote).foregroundStyle(.secondary))) {
                if holdings.isEmpty { Text("No holdings reported yet.").foregroundStyle(.secondary) }
                ForEach(holdings) { h in
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(h.ticker ?? h.securityName).font(.body.weight(.semibold))
                            Text(h.ticker != nil ? h.securityName : (h.type ?? "")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            Text("\(h.quantity.formatted(.number.precision(.fractionLength(0...3)))) shares" + (h.accountName.map { " · \($0)" } ?? ""))
                                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(Fmt.money(h.currentValue)).font(.body.monospacedDigit().weight(.medium))
                            if let gl = h.gainLoss {
                                Text("\(gl >= 0 ? "+" : "-")\(Fmt.moneyWhole(abs(gl))) \(pct(h.gainLossPercent))")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(gl >= 0 ? Color.income : .red)
                            }
                        }
                    }
                    if h.id != holdings.last?.id { Divider() }
                }
            }
        } else {
            ProgressView().padding(.top, 40)
        }
    }

    // MARK: Activity

    @ViewBuilder private var activityTab: some View {
        Card("Investment activity") {
            if txns.isEmpty { Text(txnsLoaded ? "No activity in this period." : "Loading…").foregroundStyle(.secondary) }
            ForEach(txns) { t in
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(t.securityName ?? (t.type ?? "Transaction").capitalized).font(.body.weight(.medium)).lineLimit(1)
                        Text("\((t.type ?? "").capitalized) · \(Fmt.shortDate(t.date)) · \(t.accountName)")
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        if let q = t.quantity, let p = t.price {
                            Text("\(q.formatted(.number.precision(.fractionLength(0...3)))) @ \(Fmt.money(p))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 8)
                    Text(Fmt.money(t.amount)).font(.body.monospacedDigit())
                }
                .onAppear { if t.id == txns.last?.id { Task { await loadTxns(reset: false) } } }
                if t.id != txns.last?.id { Divider() }
            }
        }
    }

    // MARK: Data

    private func reload() async {
        await loadOverview()
        await loadHoldings()
        if tab == 2 { await loadTxns(reset: true) } else { txnsLoaded = false }
    }

    private func loadOverview() async {
        do {
            overview = try await api.get("api/native/investments/overview", query: ["range": range])
            error = nil
        } catch APIError.unauthorized {
        } catch { if overview == nil { self.error = error.localizedDescription } }
    }

    private func loadHoldings() async {
        if let rows: [HoldingModel] = try? await api.get("api/native/investments/holdings", query: ["view": byAccount ? "by-account" : "consolidated"]) {
            holdings = rows
        }
    }

    private func loadTxns(reset: Bool) async {
        if !reset && nextCursor == nil { return }
        var query: [String: String] = ["limit": "40"]
        if !reset, let c = nextCursor { query["cursor"] = c }
        if let page: InvTxnPageModel = try? await api.get("api/native/investments/transactions", query: query) {
            txns = reset ? page.rows : txns + page.rows
            nextCursor = page.nextCursor
        }
        txnsLoaded = true
    }
}
