import SwiftUI
import Charts

struct DashboardView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var connection: Connection
    @State private var data: DashboardResponse?
    @State private var range = "6M"
    @State private var error: String?
    private let ranges = ["1M", "3M", "6M", "1Y", "all"]

    var body: some View {
        ScrollView {
            if let data {
                VStack(spacing: 16) {
                    netWorth(data)
                    tiles(data.summary)
                    spending(data.spending)
                    recent(data.recent)
                }
                .padding()
            } else if let error {
                ErrorState(message: error) { Task { await load() } }
            } else {
                ProgressView().padding(.top, 80)
            }
        }
        .background(Color.canvas)
        .navigationTitle("Dashboard")
        .refreshable { await load() }
        .task(id: connection.active) { await load() }
        .onChange(of: range) { _, _ in Task { await load() } }
    }

    private func load() async {
        do {
            data = try await api.get("api/native/dashboard", query: ["range": range])
            error = nil
        } catch APIError.unauthorized {
        } catch {
            if data == nil { self.error = error.localizedDescription }
        }
    }

    private func netWorth(_ d: DashboardResponse) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 4) {
                Text("Net worth").font(.subheadline).foregroundStyle(.secondary)
                Text(Fmt.money(d.summary.netWorth)).font(.system(size: 36, weight: .bold, design: .rounded)).monospacedDigit()
                HStack(spacing: 16) {
                    Label(Fmt.moneyWhole(d.summary.assets), systemImage: "arrow.up.right").foregroundStyle(Color.income)
                    Label(Fmt.moneyWhole(abs(d.summary.liabilities)), systemImage: "arrow.down.right").foregroundStyle(.red)
                }
                .font(.footnote.weight(.medium))
            }
            if d.history.count > 1 {
                Chart(d.history) { p in
                    if let date = Fmt.date(p.date) {
                        AreaMark(x: .value("Date", date), y: .value("Net worth", Double(p.netWorth) / 100))
                            .foregroundStyle(LinearGradient(colors: [Color.accentColor.opacity(0.3), .clear], startPoint: .top, endPoint: .bottom))
                        LineMark(x: .value("Date", date), y: .value("Net worth", Double(p.netWorth) / 100))
                            .foregroundStyle(Color.accentColor)
                            .interpolationMethod(.monotone)
                    }
                }
                .chartYAxis { AxisMarks(position: .trailing) { AxisValueLabel(format: .currency(code: "USD").notation(.compactName)) } }
                .frame(height: 150)
            }
            Picker("Range", selection: $range) {
                ForEach(ranges, id: \.self) { Text($0 == "all" ? "All" : $0).tag($0) }
            }
            .pickerStyle(.segmented)
        }
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
                            Capsule().fill(Color.accentColor.opacity(0.18))
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

    private func recent(_ rows: [Txn]) -> some View {
        Card("Recent transactions") {
            ForEach(rows) { txn in
                NavigationLink(value: txn) { TxnRow(txn: txn) }.buttonStyle(.plain)
                if txn.id != rows.last?.id { Divider() }
            }
        }
    }
}
