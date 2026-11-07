import SwiftUI
import Charts

struct SpendRowModel: Codable, Identifiable {
    let categoryId: String?
    let categoryName: String
    let groupName: String?
    let categoryIcon: String?
    let total: Int
    let prevTotal: Int?
    var id: String { categoryId ?? "uncategorized" }
}

struct SpendingReport: Codable {
    let comparisonLabel: String?
    let rows: [SpendRowModel]
    let totalIncome: Int
}

struct MonthlyRow: Codable, Identifiable {
    let period: String
    let income: Int
    let expenses: Int
    let net: Int
    var id: String { period }
}

struct IECategoryRow: Codable, Identifiable {
    let categoryId: String?
    let categoryName: String
    let categoryIcon: String?
    let isIncome: Bool
    let total: Int
    let monthlyAverage: Int
    let percentOfTotal: Double
    var id: String { (categoryId ?? "uncategorized") + (isIncome ? "+" : "-") }
}

struct IncomeExpenseReport: Codable {
    let monthly: [MonthlyRow]
    let byCategory: [IECategoryRow]
}

struct SafeToSpendModel: Codable {
    let monthlyIncome: Int
    let recurringExpenses: Int
    let discretionarySpent: Int
    let safeToSpend: Int
    let month: String
}

struct CashFlowReport: Codable {
    let safeToSpend: SafeToSpendModel
    let monthly: [MonthlyRow]
}

struct TrendRow: Codable, Identifiable {
    let period: String
    let categoryId: String?
    let categoryName: String
    let total: Int
    var id: String { period + "|" + (categoryId ?? "u") }
}

struct TrendsReport: Codable { let rows: [TrendRow] }

struct NetWorthRow: Codable, Identifiable {
    let date: String
    let assets: Int
    let liabilities: Int
    let netWorth: Int
    var id: String { date }
}

struct NetWorthReport: Codable { let rows: [NetWorthRow] }

enum ReportTab: String, CaseIterable, Identifiable {
    case spending, incomeExpense = "income-expense", cashFlow = "cash-flow", trends, netWorth = "net-worth"
    var id: String { rawValue }
    var title: String {
        switch self {
        case .spending: return "Spending"
        case .incomeExpense: return "Income vs expense"
        case .cashFlow: return "Cash flow"
        case .trends: return "Trends"
        case .netWorth: return "Net worth"
        }
    }
}

struct ReportsView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var connection: Connection
    @State private var tab: ReportTab = .spending
    @State private var range = "3M"
    @State private var spending: SpendingReport?
    @State private var ie: IncomeExpenseReport?
    @State private var cash: CashFlowReport?
    @State private var trends: TrendsReport?
    @State private var worth: NetWorthReport?
    @State private var error: String?
    @State private var loading = false

    private struct Key: Hashable { let tab: ReportTab; let range: String; let base: URL? }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Picker("Report", selection: $tab) {
                    ForEach(ReportTab.allCases) { Text($0.title).tag($0) }
                }
                #if os(iOS)
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, alignment: .leading)
                #else
                .pickerStyle(.segmented)
                #endif
                Picker("Range", selection: $range) {
                    ForEach(["1M", "3M", "6M", "1Y", "all"], id: \.self) { Text($0 == "all" ? "All" : $0).tag($0) }
                }
                .pickerStyle(.segmented)
                if let error { ErrorState(message: error) { Task { await load() } } }
                else {
                    if let digest = aiDigest {
                        OnDeviceInsightCard(title: "Summary", prompt: "Summarize this report", resetKey: "\(tab.rawValue)|\(range)|\(digest.count)") {
                            await OnDeviceAI.reportSummary(title: tab.title, range: range, data: digest)
                        }
                    }
                    switch tab {
                    case .spending: spendingView
                    case .incomeExpense: incomeExpenseView
                    case .cashFlow: cashFlowView
                    case .trends: trendsView
                    case .netWorth: netWorthView
                    }
                }
            }
            .padding()
            .opacity(loading ? 0.6 : 1)
        }
        .background(Color.canvas)
        .navigationTitle("Reports")
        .refreshable { await api.syncBanks(); await load() }
        .task(id: Key(tab: tab, range: range, base: connection.active)) { await load() }
    }

    // MARK: Spending

    @ViewBuilder private var spendingView: some View {
        if let s = spending {
            let total = s.rows.reduce(0) { $0 + $1.total }
            Card {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Total spending").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    Text(Fmt.money(total)).font(.system(size: 36, weight: .bold)).monospacedDigit()
                    if s.totalIncome > 0 {
                        Text("Income \(Fmt.moneyWhole(s.totalIncome)) · Saved \(Fmt.moneyWhole(s.totalIncome - total))")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                let top = Array(s.rows.sorted { $0.total > $1.total }.prefix(8))
                let maxTotal = Double(top.first?.total ?? 1)
                ForEach(top) { r in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(r.categoryName).font(.subheadline)
                            Spacer()
                            Text(Fmt.moneyWhole(r.total)).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        ProgressBar(fraction: Double(r.total) / maxTotal)
                    }
                }
            }
            Card("By category", trailing: s.comparisonLabel.map { AnyView(Text($0).font(.caption).foregroundStyle(.secondary)) }) {
                ForEach(s.rows.sorted { $0.total > $1.total }) { r in
                    HStack(spacing: 12) {
                        CategoryBadge(icon: r.categoryIcon, size: 32)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.categoryName).font(.body)
                            if let g = r.groupName { Text(g).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(Fmt.money(r.total)).font(.body.monospacedDigit())
                            if let prev = r.prevTotal, prev > 0 {
                                let delta = Double(r.total - prev) / Double(prev) * 100
                                Text(String(format: "%@%.0f%%", delta >= 0 ? "+" : "", delta))
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(delta > 0 ? Color.alert : Color.income)
                            } else if s.comparisonLabel != nil {
                                Text("New").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if r.id != s.rows.last?.id { Divider() }
                }
            }
        } else { ProgressView().padding(.top, 60) }
    }

    // MARK: Income vs expense

    @ViewBuilder private var incomeExpenseView: some View {
        if let r = ie {
            let inc = r.monthly.reduce(0) { $0 + $1.income }
            let exp = r.monthly.reduce(0) { $0 + $1.expenses }
            HStack(spacing: 12) {
                tile("Income", Fmt.moneyWhole(inc), Color.income)
                tile("Expenses", Fmt.moneyWhole(exp), .primary)
                tile("Net", Fmt.moneyWhole(inc - exp), inc - exp < 0 ? .red : Color.income)
            }
            Card("By month") {
                Chart {
                    ForEach(r.monthly) { m in
                        BarMark(x: .value("Month", m.period), y: .value("Amount", Double(m.income) / 100))
                            .position(by: .value("Type", "Income")).foregroundStyle(Color.income)
                        BarMark(x: .value("Month", m.period), y: .value("Amount", Double(m.expenses) / 100))
                            .position(by: .value("Type", "Expenses")).foregroundStyle(Color.accentColor)
                    }
                }
                .chartYAxis { AxisMarks(position: .trailing) { AxisValueLabel(format: .currency(code: "USD").notation(.compactName)) } }
                .frame(height: 180)
            }
            categoryList("Income by category", r.byCategory.filter(\.isIncome))
            categoryList("Expenses by category", r.byCategory.filter { !$0.isIncome })
        } else { ProgressView().padding(.top, 60) }
    }

    private func categoryList(_ title: String, _ rows: [IECategoryRow]) -> some View {
        Group {
            if !rows.isEmpty {
                Card(title) {
                    ForEach(rows) { r in
                        HStack(spacing: 12) {
                            CategoryBadge(icon: r.categoryIcon, size: 32)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(r.categoryName)
                                Text("\(Fmt.moneyWhole(r.monthlyAverage))/mo avg").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text(Fmt.money(r.total)).font(.body.monospacedDigit())
                                Text(String(format: "%.0f%%", r.percentOfTotal)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        if r.id != rows.last?.id { Divider() }
                    }
                }
            }
        }
    }

    // MARK: Cash flow

    @ViewBuilder private var cashFlowView: some View {
        if let c = cash {
            let s = c.safeToSpend
            Card("Safe to spend this month") {
                Text(Fmt.money(s.safeToSpend)).font(.system(size: 36, weight: .bold)).monospacedDigit()
                    .foregroundStyle(s.safeToSpend < 0 ? Color.red : Color.primary)
                VStack(spacing: 6) {
                    line("Income this month", s.monthlyIncome)
                    line("Bills still due", -s.recurringExpenses)
                    line("Spent so far", -s.discretionarySpent)
                }
                Text("Always covers the current calendar month, regardless of the range above.").font(.caption).foregroundStyle(.secondary)
            }
            Card("Net by month") {
                Chart(c.monthly) { m in
                    BarMark(x: .value("Month", m.period), y: .value("Net", Double(m.net) / 100))
                        .foregroundStyle(m.net >= 0 ? Color.income : Color.red)
                }
                .chartYAxis { AxisMarks(position: .trailing) { AxisValueLabel(format: .currency(code: "USD").notation(.compactName)) } }
                .frame(height: 170)
            }
        } else { ProgressView().padding(.top, 60) }
    }

    private func line(_ label: String, _ cents: Int) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text("\(cents < 0 ? "-" : "")\(Fmt.money(abs(cents)))").monospacedDigit()
        }
        .font(.subheadline)
    }

    // MARK: Trends

    @ViewBuilder private var trendsView: some View {
        if let t = trends {
            let totals = Dictionary(grouping: t.rows, by: \.categoryName).mapValues { $0.reduce(0) { $0 + $1.total } }
            let top = Set(totals.sorted { $0.value > $1.value }.prefix(6).map(\.key))
            let shown = t.rows.filter { top.contains($0.categoryName) }
            Card("Top categories by month") {
                if shown.isEmpty { Text("No spending in this period.").foregroundStyle(.secondary) }
                else {
                    Chart(shown) { r in
                        BarMark(x: .value("Month", r.period), y: .value("Spent", Double(r.total) / 100))
                            .foregroundStyle(by: .value("Category", r.categoryName))
                    }
                    .chartYAxis { AxisMarks(position: .trailing) { AxisValueLabel(format: .currency(code: "USD").notation(.compactName)) } }
                    .frame(height: 240)
                }
            }
            Card("Totals") {
                ForEach(totals.sorted { $0.value > $1.value }, id: \.key) { name, total in
                    HStack { Text(name); Spacer(); Text(Fmt.money(total)).monospacedDigit() }.font(.subheadline)
                }
            }
        } else { ProgressView().padding(.top, 60) }
    }

    // MARK: Net worth

    @ViewBuilder private var netWorthView: some View {
        if let w = worth, let last = w.rows.last {
            Card {
                Text("Net worth").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                Text(Fmt.money(last.netWorth)).font(.system(size: 36, weight: .bold)).monospacedDigit()
                if let first = w.rows.first, first.date != last.date {
                    let d = last.netWorth - first.netWorth
                    Text("\(d >= 0 ? "+" : "-")\(Fmt.moneyWhole(abs(d))) since \(Fmt.shortDate(first.date))")
                        .font(.footnote.weight(.medium)).foregroundStyle(d >= 0 ? Color.income : .red)
                }
                Chart(w.rows) { p in
                    if let d = Fmt.date(p.date) {
                        LineMark(x: .value("Date", d), y: .value("Assets", Double(p.assets) / 100)).foregroundStyle(by: .value("Series", "Assets"))
                        LineMark(x: .value("Date", d), y: .value("Debts", Double(abs(p.liabilities)) / 100)).foregroundStyle(by: .value("Series", "Debts"))
                        LineMark(x: .value("Date", d), y: .value("Net", Double(p.netWorth) / 100)).foregroundStyle(by: .value("Series", "Net worth"))
                    }
                }
                .chartForegroundStyleScale(["Assets": Color.income, "Debts": Color.red, "Net worth": Color.accentColor])
                .chartYAxis { AxisMarks(position: .trailing) { AxisValueLabel(format: .currency(code: "USD").notation(.compactName)) } }
                .frame(height: 220)
            }
        } else if worth != nil {
            Card { Text("No balance history yet.").foregroundStyle(.secondary) }
        } else { ProgressView().padding(.top, 60) }
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

    /// Compact text of the loaded report for the on-device summary; nil until it has loaded.
    private var aiDigest: String? {
        func m(_ c: Int) -> String { Fmt.moneyWhole(c) }
        switch tab {
        case .spending:
            guard let s = spending else { return nil }
            return "Income \(m(s.totalIncome)). Spending by category" + (s.comparisonLabel.map { " (vs \($0))" } ?? "") + ":\n"
                + s.rows.sorted { $0.total > $1.total }.prefix(15).map { "\($0.categoryName) \(m($0.total))" + ($0.prevTotal.map { " (before \(m($0))" + ")" } ?? "") }.joined(separator: "\n")
        case .incomeExpense:
            guard let r = ie else { return nil }
            return "By month:\n" + r.monthly.map { "\($0.period): income \(m($0.income)), expenses \(m($0.expenses)), net \(m($0.net))" }.joined(separator: "\n")
                + "\nTop expense categories:\n" + r.byCategory.filter { !$0.isIncome }.sorted { $0.total > $1.total }.prefix(8).map { "\($0.categoryName) \(m($0.total))" }.joined(separator: "\n")
        case .cashFlow:
            guard let c = cash else { return nil }
            let s = c.safeToSpend
            return "Safe to spend \(m(s.safeToSpend)) for \(s.month): income \(m(s.monthlyIncome)), recurring bills \(m(s.recurringExpenses)), discretionary spent \(m(s.discretionarySpent)).\n"
                + c.monthly.map { "\($0.period): income \(m($0.income)), expenses \(m($0.expenses)), net \(m($0.net))" }.joined(separator: "\n")
        case .trends:
            guard let t = trends else { return nil }
            return t.rows.map { "\($0.period) \($0.categoryName) \(m($0.total))" }.joined(separator: "\n")
        case .netWorth:
            guard let w = worth, let first = w.rows.first, let last = w.rows.last else { return nil }
            return "From \(first.date): net worth \(m(first.netWorth)), assets \(m(first.assets)), liabilities \(m(first.liabilities)).\nTo \(last.date): net worth \(m(last.netWorth)), assets \(m(last.assets)), liabilities \(m(last.liabilities))."
        }
    }

    // MARK: Data

    private func load() async {
        loading = true
        defer { loading = false }
        let path = "api/native/reports/\(tab.rawValue)"
        let query = ["range": range]
        do {
            switch tab {
            case .spending: spending = try await api.get(path, query: query)
            case .incomeExpense: ie = try await api.get(path, query: query)
            case .cashFlow: cash = try await api.get(path, query: query)
            case .trends: trends = try await api.get(path, query: query)
            case .netWorth: worth = try await api.get(path, query: query)
            }
            error = nil
        } catch APIError.unauthorized {
        } catch { self.error = error.localizedDescription }
    }
}
