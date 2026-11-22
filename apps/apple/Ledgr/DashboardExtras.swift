import SwiftUI

/// The dashboard cards the web app has beyond net worth, spending and recent transactions:
/// budget progress, upcoming bills, account balances and the investments summary. Each card
/// loads on its own and stays out of the way when there is nothing to show (no budget yet,
/// no investment accounts).
struct DashboardExtras: View {
    var body: some View {
        VStack(spacing: 16) {
            BudgetProgressCard()
            UpcomingBillsCard()
            AccountBalancesCard()
            InvestmentsCard()
        }
    }
}

// MARK: Budget progress

private struct BudgetProgressCard: View {
    @EnvironmentObject var api: API
    @State private var budget: BudgetResponse?

    var body: some View {
        Group {
            if let budget, budget.budget != nil, budget.summary.totalBudgeted > 0 {
                let s = budget.summary
                let ratio = min(Double(s.totalSpent) / Double(max(s.totalBudgeted, 1)), 1)
                Card("Budget") {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("\(Fmt.moneyWhole(s.totalSpent)) of \(Fmt.moneyWhole(s.totalBudgeted))").font(.subheadline.monospacedDigit())
                            Spacer()
                            Text(s.totalRemaining >= 0 ? "\(Fmt.moneyWhole(s.totalRemaining)) left" : "\(Fmt.moneyWhole(-s.totalRemaining)) over")
                                .font(.subheadline.weight(.medium)).foregroundStyle(s.totalRemaining >= 0 ? Color.income : Color.alert)
                        }
                        GeometryReader { geo in
                            Capsule().fill(Color.track).overlay(alignment: .leading) {
                                Capsule().fill(s.totalRemaining >= 0 ? Color.accentColor : Color.alert).frame(width: max(6, geo.size.width * ratio))
                            }
                        }
                        .frame(height: 8)
                    }
                    ForEach(budget.groups.filter { $0.totalBudgeted > 0 }.sorted { $0.totalSpent > $1.totalSpent }.prefix(4)) { g in
                        HStack {
                            Text(g.groupName).font(.footnote)
                            Spacer()
                            Text("\(Fmt.moneyWhole(g.totalSpent)) / \(Fmt.moneyWhole(g.totalBudgeted))")
                                .font(.footnote.monospacedDigit())
                                .foregroundStyle(g.totalSpent > g.totalBudgeted ? Color.alert : Color.secondary)
                        }
                    }
                }
            }
        }
        .task { budget = try? await api.get("api/native/budgets") }
    }
}

// MARK: Upcoming bills

private struct Bill: Codable, Identifiable {
    let id: String
    let name: String
    let averageAmount: Int?
    let lastAmount: Int?
    let nextDate: String?
    let relativeDateLabel: String?
    let status: String?
}

private struct UpcomingBillsCard: View {
    @EnvironmentObject var api: API
    @State private var bills: [Bill] = []

    var body: some View {
        Group {
            if !bills.isEmpty {
                Card("Upcoming bills") {
                    ForEach(bills) { b in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(b.name).font(.subheadline).lineLimit(1)
                                if let label = b.relativeDateLabel ?? b.nextDate.map({ Fmt.shortDate($0) }) {
                                    Text(label).font(.caption).foregroundStyle(b.status == "overdue" ? Color.alert : Color.secondary)
                                }
                            }
                            Spacer()
                            if let amount = b.averageAmount ?? b.lastAmount {
                                Text(Fmt.money(abs(amount))).font(.subheadline.monospacedDigit())
                            }
                        }
                        if b.id != bills.last?.id { Divider() }
                    }
                }
            }
        }
        .task { bills = (try? await api.get("api/native/upcoming-bills", query: ["limit": "5"])) ?? [] }
    }
}

// MARK: Account balances

private struct AccountBalancesCard: View {
    @EnvironmentObject var api: API
    @State private var groups: [InstitutionGroupModel] = []

    private var rows: [AccountRowModel] {
        groups.flatMap(\.accounts).filter { !$0.isHidden && $0.currentBalance != nil }
            .sorted { abs($0.currentBalance ?? 0) > abs($1.currentBalance ?? 0) }
    }

    var body: some View {
        Group {
            if !rows.isEmpty {
                Card("Accounts") {
                    ForEach(rows.prefix(6)) { a in
                        NavigationLink(value: a) {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(a.name).font(.subheadline).lineLimit(1)
                                    Text(a.typeLabel).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(Fmt.money(a.currentBalance ?? 0)).font(.subheadline.monospacedDigit())
                            }
                        }
                        .buttonStyle(.plain)
                        if a.id != rows.prefix(6).last?.id { Divider() }
                    }
                }
            }
        }
        .task { if let r: AccountsResponse = try? await api.get("api/native/accounts") { groups = r.groups } }
    }
}

// MARK: Investments

private struct InvestmentsCard: View {
    @EnvironmentObject var api: API
    @State private var summary: PortfolioSummaryModel?

    var body: some View {
        Group {
            if let s = summary, s.totalValue != 0 {
                Card("Investments") {
                    HStack(alignment: .firstTextBaseline) {
                        Text(Fmt.moneyWhole(s.totalValue)).font(.title2.weight(.semibold).monospacedDigit())
                        Spacer()
                        if let day = s.dayChange {
                            Text("\(day >= 0 ? "+" : "")\(Fmt.moneyWhole(day)) today")
                                .font(.footnote.weight(.medium)).foregroundStyle(day >= 0 ? Color.income : Color.alert)
                        }
                    }
                    if s.gainLossCoverage > 0 {
                        HStack {
                            Text("Total gain / loss").font(.footnote).foregroundStyle(.secondary)
                            Spacer()
                            Text("\(s.totalGainLoss >= 0 ? "+" : "")\(Fmt.moneyWhole(s.totalGainLoss))")
                                .font(.footnote.monospacedDigit()).foregroundStyle(s.totalGainLoss >= 0 ? Color.income : Color.alert)
                        }
                    }
                }
            }
        }
        .task { if let o: InvestmentsOverview = try? await api.get("api/native/investments/overview", query: ["range": "1M"]) { summary = o.summary } }
    }
}
