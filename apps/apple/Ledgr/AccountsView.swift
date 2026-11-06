import SwiftUI
import Charts

struct AccountRowModel: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let officialName: String?
    let type: String
    let subtype: String?
    let currentBalance: Int?
    let availableBalance: Int?
    let creditLimit: Int?
    let isHidden: Bool
    let isManual: Bool

    var typeLabel: String {
        (subtype ?? type).replacingOccurrences(of: "_", with: " ").capitalized
    }
    var symbol: String {
        switch type {
        case "checking", "savings": return "building.columns"
        case "credit": return "creditcard"
        case "investment": return "chart.line.uptrend.xyaxis"
        case "loan": return "house"
        default: return "banknote"
        }
    }
}

struct InstitutionGroupModel: Codable, Identifiable {
    let institutionName: String
    let provider: String?
    let status: String?
    let errorMessage: String?
    let lastDataAt: String?
    let accounts: [AccountRowModel]
    var id: String { institutionName }
    var subtotal: Int { accounts.filter { !$0.isHidden }.reduce(0) { $0 + ($1.currentBalance ?? 0) } }
}

struct AccountTotals: Codable {
    let totalAssets: Int
    let totalLiabilities: Int
    let netWorth: Int
}

struct AccountsResponse: Codable {
    let summary: AccountTotals
    let groups: [InstitutionGroupModel]
}

struct BalancePoint: Codable, Identifiable {
    let date: String
    let balance: Int
    var id: String { date }
}

struct AccountsView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var connection: Connection
    @State private var data: AccountsResponse?
    @State private var error: String?
    @State private var showHidden = false

    var body: some View {
        ScrollView {
            if let data {
                VStack(spacing: 16) {
                    totals(data.summary)
                    ForEach(data.groups) { group in
                        groupCard(group)
                    }
                }
                .padding()
            } else if let error {
                ErrorState(message: error) { Task { await load() } }
            } else {
                ProgressView().padding(.top, 80)
            }
        }
        .background(Color.canvas)
        .navigationTitle("Accounts")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Toggle(isOn: $showHidden) { Image(systemName: showHidden ? "eye" : "eye.slash") }
                    .toggleStyle(.button)
                    .help("Show hidden accounts")
            }
        }
        .refreshable { await load() }
        .task(id: connection.active) { await load() }
    }

    private func load() async {
        do {
            data = try await api.get("api/native/accounts")
            error = nil
        } catch APIError.unauthorized {
        } catch {
            if data == nil { self.error = error.localizedDescription }
        }
    }

    private func totals(_ s: AccountTotals) -> some View {
        HStack(spacing: 12) {
            tile("Net worth", Fmt.moneyWhole(s.netWorth), .primary)
            tile("Assets", Fmt.moneyWhole(s.totalAssets), Color.income)
            tile("Debts", Fmt.moneyWhole(abs(s.totalLiabilities)), s.totalLiabilities == 0 ? .primary : .red)
        }
    }

    private func tile(_ label: String, _ value: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold).monospacedDigit()).foregroundStyle(color)
                .minimumScaleFactor(0.7).lineLimit(1)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.hairline, lineWidth: 1))
    }

    private func groupCard(_ group: InstitutionGroupModel) -> some View {
        let rows = group.accounts.filter { showHidden || !$0.isHidden }
        return Group {
            if !rows.isEmpty {
                Card(group.institutionName, trailing: AnyView(Text(Fmt.money(group.subtotal)).font(.subheadline.weight(.semibold).monospacedDigit()))) {
                    VStack(alignment: .leading, spacing: 2) {
                        if group.status == "error" || group.status == "login_required" {
                            Label(group.errorMessage ?? "Needs attention", systemImage: "exclamationmark.triangle.fill")
                                .font(.caption).foregroundStyle(Color.alert)
                        } else if let when = group.lastDataAt {
                            Text("Updated \(Fmt.relative(when))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    ForEach(rows) { account in
                        NavigationLink(value: account) { AccountRow(account: account) }.buttonStyle(.plain)
                        if account.id != rows.last?.id { Divider() }
                    }
                }
            }
        }
    }
}

struct AccountRow: View {
    let account: AccountRowModel

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: account.symbol)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 38, height: 38)
                .background(Color.accentColor.opacity(0.14), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(account.name).font(.body.weight(.medium)).lineLimit(1)
                Text(account.typeLabel + (account.isHidden ? " · Hidden" : "")).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if let bal = account.currentBalance {
                Text(Fmt.money(bal)).font(.body.monospacedDigit().weight(.medium))
                    .foregroundStyle(bal < 0 ? Color.primary : Color.primary)
            }
        }
        .contentShape(Rectangle())
    }
}

struct AccountDetailView: View {
    let account: AccountRowModel
    @EnvironmentObject var api: API
    @State private var history: [BalancePoint] = []
    @State private var txns: [Txn] = []
    @State private var days = 90
    @State private var loaded = false

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Card {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(account.typeLabel).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                        Text(Fmt.money(account.currentBalance ?? 0))
                            .font(.system(size: 36, weight: .bold)).monospacedDigit()
                        if let avail = account.availableBalance, account.type != "credit" {
                            Text("Available \(Fmt.money(avail))").font(.footnote).foregroundStyle(.secondary)
                        }
                        if let limit = account.creditLimit, limit > 0 {
                            Text("Credit limit \(Fmt.money(limit))").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    if history.count > 1 {
                        Chart(history) { p in
                            if let date = Fmt.date(p.date) {
                                AreaMark(x: .value("Date", date), y: .value("Balance", Double(p.balance) / 100))
                                    .foregroundStyle(LinearGradient(colors: [Color.accentColor.opacity(0.3), .clear], startPoint: .top, endPoint: .bottom))
                                LineMark(x: .value("Date", date), y: .value("Balance", Double(p.balance) / 100))
                                    .foregroundStyle(Color.accentColor).interpolationMethod(.monotone)
                            }
                        }
                        .chartYAxis { AxisMarks(position: .trailing) { AxisValueLabel(format: .currency(code: "USD").notation(.compactName)) } }
                        .frame(height: 140)
                    }
                    Picker("Range", selection: $days) {
                        Text("1M").tag(30); Text("3M").tag(90); Text("1Y").tag(365); Text("All").tag(1825)
                    }
                    .pickerStyle(.segmented)
                }
                Card("Recent transactions") {
                    if txns.isEmpty {
                        Text(loaded ? "No transactions" : "Loading…").foregroundStyle(.secondary)
                    }
                    ForEach(txns) { txn in
                        NavigationLink(value: txn) { TxnRow(txn: txn) }.buttonStyle(.plain)
                        if txn.id != txns.last?.id { Divider() }
                    }
                }
            }
            .padding()
        }
        .background(Color.canvas)
        .navigationTitle(account.name)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task { await loadTxns() }
        .task(id: days) { await loadHistory() }
    }

    private func loadHistory() async {
        if let h: [BalancePoint] = try? await api.get("api/native/accounts/\(account.id)/history", query: ["days": String(days)]) {
            history = h
        }
    }

    private func loadTxns() async {
        if let page: TxnPage = try? await api.get("api/native/transactions", query: ["accountId": account.id, "limit": "25"]) {
            txns = page.rows
        }
        loaded = true
    }
}

extension Fmt {
    /// "3 hours ago" for an ISO timestamp.
    static func relative(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let d else { return iso }
        return RelativeDateTimeFormatter().localizedString(for: d, relativeTo: Date())
    }
}
