import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// A list the app shows under an answer. Tools fill these in directly from server data, so the
/// full, correctly formatted list never depends on the model copying it out line by line.
struct AnswerTable: Identifiable {
    struct Row: Identifiable {
        let id = UUID()
        let name: String
        let detail: String?
        let amount: String?
    }

    let id = UUID()
    let title: String
    let rows: [Row]
    /// One line under the list, such as a total.
    let footer: String?
}

/// Collects the tables tools produce while the model is answering. Tools run off the main
/// thread, hence the lock.
final class AnswerSink: @unchecked Sendable {
    private let lock = NSLock()
    private var tables: [AnswerTable] = []

    func add(_ table: AnswerTable) {
        lock.lock(); defer { lock.unlock() }
        tables.removeAll { $0.title == table.title }
        tables.append(table)
    }

    var all: [AnswerTable] {
        lock.lock(); defer { lock.unlock() }
        return tables
    }
}

#if canImport(FoundationModels)

/// Tools the on-device model can call to look things up while answering a question in search.
/// Each reads from the same server endpoints the app's screens use. A tool does two things: it
/// puts the full list into the sink (shown to the user as a table) and returns a short digest
/// to the model, which has a small context window. Amounts arrive in cents and are formatted
/// as dollars here so the model never converts.

private struct AskBudgetDigest: Decodable {
    struct Summary: Decodable { let totalBudgeted: Int; let totalSpent: Int; let totalRemaining: Int }
    struct Category: Decodable { let categoryName: String; let limitAmount: Int; let spent: Int; let remaining: Int }
    struct Group: Decodable { let groupName: String; let categories: [Category] }
    let month: String
    let groups: [Group]
    let summary: Summary
}

private struct AskSpendingDigest: Decodable {
    struct Row: Decodable { let categoryName: String; let total: Int }
    let dateFrom: String
    let dateTo: String
    let rows: [Row]
    let totalIncome: Int
}

private struct HoldingLine: Decodable {
    let ticker: String?
    let securityName: String?
    let currentValue: Int
}

/// How many times a charge lands in a month, so yearly and bi-weekly charges compare fairly.
private func monthlyFactor(_ frequency: String?) -> Double {
    switch frequency?.lowercased() {
    case "weekly": return 52.0 / 12
    case "biweekly": return 26.0 / 12
    case "semimonthly": return 2
    case "quarterly": return 1.0 / 3
    case "semiannual", "semiannually": return 1.0 / 6
    case "yearly", "annual", "annually": return 1.0 / 12
    default: return 1
    }
}

@available(iOS 27.0, macOS 27.0, *)
struct SubscriptionsTool: Tool {
    let api: API
    let sink: AnswerSink
    let name = "getSubscriptions"
    let description = "Gets the user's recurring bills and subscriptions with the monthly total. The app shows the full list to the user, so you only receive a summary. Use for any question about subscriptions, bills, recurring charges or upcoming payments."

    @Generable struct Arguments {}

    func call(arguments: Arguments) async throws -> String {
        let r: RecurringResponse = try await api.get("api/native/recurring")
        let g = r.groups
        let active = (g.overdue + g.thisMonth + g.future).sorted { Double($0.amount) * monthlyFactor($0.frequency) > Double($1.amount) * monthlyFactor($1.frequency) }
        let paused = g.paused
        if active.isEmpty && paused.isEmpty { return "No recurring items have been found yet." }

        func row(_ i: RecurringItem, paused: Bool) -> AnswerTable.Row {
            let monthly = Int(Double(i.amount) * monthlyFactor(i.frequency))
            var parts = [i.frequencyLabel]
            if monthlyFactor(i.frequency) != 1 { parts.append("\(Fmt.money(monthly))/mo") }
            if paused { parts.append("paused") } else if let next = i.nextDate { parts.append("next \(next)") }
            return .init(name: i.name, detail: parts.filter { !$0.isEmpty }.joined(separator: " · "), amount: Fmt.money(i.amount))
        }
        sink.add(AnswerTable(
            title: "Recurring charges",
            rows: active.map { row($0, paused: false) } + paused.map { row($0, paused: true) },
            footer: "About \(Fmt.money(r.summary.monthlyExpenses)) a month"))

        let top = active.prefix(5).map { "\($0.name) \(Fmt.money(Int(Double($0.amount) * monthlyFactor($0.frequency))))/mo" }
        return "\(active.count) active and \(paused.count) paused recurring items; about \(Fmt.money(r.summary.monthlyExpenses)) a month in total. Largest: \(top.joined(separator: "; ")). The full list is already shown to the user."
    }
}

@available(iOS 27.0, macOS 27.0, *)
struct BudgetTool: Tool {
    let api: API
    let sink: AnswerSink
    let name = "getBudget"
    let description = "Gets the budget for a month: totals and each category's spending against its limit. The app shows the table, so you receive a summary. Use for questions about budgets, limits, what is left to spend, or overspending."

    @Generable struct Arguments {
        @Guide(description: "Month as YYYY-MM, or an empty string for the current month")
        var month: String
    }

    func call(arguments: Arguments) async throws -> String {
        var q: [String: String] = [:]
        let m = arguments.month.trimmingCharacters(in: .whitespaces)
        if m.count == 7 { q["month"] = m }
        let b: AskBudgetDigest = try await api.get("api/native/budgets", query: q)
        let s = b.summary
        let cats = b.groups.flatMap { $0.categories }.sorted { $0.remaining < $1.remaining }
        if cats.isEmpty { return "There is no budget set up for \(b.month)." }

        sink.add(AnswerTable(
            title: "Budget \(b.month)",
            rows: cats.prefix(20).map { c in
                .init(name: c.categoryName,
                      detail: "\(Fmt.money(c.spent)) of \(Fmt.money(c.limitAmount))",
                      amount: c.remaining < 0 ? "\(Fmt.money(-c.remaining)) over" : "\(Fmt.money(c.remaining)) left")
            },
            footer: "\(Fmt.money(s.totalSpent)) spent of \(Fmt.money(s.totalBudgeted))"))

        let over = cats.filter { $0.remaining < 0 }.prefix(4).map { "\($0.categoryName) over by \(Fmt.money(-$0.remaining))" }
        return "Budget \(b.month): \(Fmt.money(s.totalSpent)) spent of \(Fmt.money(s.totalBudgeted)), \(Fmt.money(s.totalRemaining)) left. \(over.isEmpty ? "Nothing is over budget." : "Over budget: " + over.joined(separator: "; ") + "."). The table is already shown to the user."
    }
}

@available(iOS 27.0, macOS 27.0, *)
struct SpendingTool: Tool {
    let api: API
    let sink: AnswerSink
    let name = "getSpendingByCategory"
    let description = "Gets total spending per category and total income over a period. The app shows the table, so you receive a summary. Use for questions about where money went, biggest expenses, or spending on a kind of thing such as food or gas."

    @Generable struct Arguments {
        @Guide(description: "One of 1M (last month), 3M, 6M, 1Y or all")
        var range: String
    }

    func call(arguments: Arguments) async throws -> String {
        let allowed = ["1M", "3M", "6M", "1Y", "all"]
        let range = allowed.contains(arguments.range) ? arguments.range : "1M"
        let r: AskSpendingDigest = try await api.get("api/native/reports/spending", query: ["range": range])
        let rows = r.rows.sorted { $0.total > $1.total }
        let total = rows.reduce(0) { $0 + $1.total }
        guard total > 0 else { return "No spending found from \(r.dateFrom) to \(r.dateTo)." }

        sink.add(AnswerTable(
            title: "Spending \(r.dateFrom) to \(r.dateTo)",
            rows: rows.prefix(15).map { c in
                .init(name: c.categoryName, detail: "\(Int((Double(c.total) / Double(total) * 100).rounded()))% of spending", amount: Fmt.money(c.total))
            },
            footer: "Spending \(Fmt.money(total)) · Income \(Fmt.money(r.totalIncome))"))

        let top = rows.prefix(5).map { "\($0.categoryName) \(Fmt.money($0.total))" }
        return "From \(r.dateFrom) to \(r.dateTo): spending \(Fmt.money(total)), income \(Fmt.money(r.totalIncome)). Top categories: \(top.joined(separator: "; ")). The table is already shown to the user."
    }
}

@available(iOS 27.0, macOS 27.0, *)
struct AccountsTool: Tool {
    let api: API
    let sink: AnswerSink
    let name = "getAccounts"
    let description = "Gets the user's accounts with balances, and total assets, liabilities and net worth. The app shows the list, so you receive a summary. Use for questions about balances, net worth, debt, or a specific account."

    @Generable struct Arguments {}

    func call(arguments: Arguments) async throws -> String {
        let r: AccountsResponse = try await api.get("api/native/accounts")
        let accounts = r.groups.flatMap { g in g.accounts.filter { !$0.isHidden }.map { (g.institutionName, $0) } }
            .sorted { abs($0.1.currentBalance ?? 0) > abs($1.1.currentBalance ?? 0) }
        let t = r.summary
        sink.add(AnswerTable(
            title: "Accounts",
            rows: accounts.prefix(25).map { inst, a in
                .init(name: a.name, detail: "\(inst) · \(a.type.capitalized)", amount: Fmt.money(a.currentBalance ?? 0))
            },
            footer: "Net worth \(Fmt.money(t.netWorth))"))
        return "Net worth \(Fmt.money(t.netWorth)); assets \(Fmt.money(t.totalAssets)); liabilities \(Fmt.money(t.totalLiabilities)); \(accounts.count) accounts. The list is already shown to the user."
    }
}

@available(iOS 27.0, macOS 27.0, *)
struct FindTransactionsTool: Tool {
    let api: API
    let sink: AnswerSink
    let name = "findTransactions"
    let description = "Finds the user's most recent transactions matching a merchant or description. The app shows them, so you receive a summary. Use for questions about a specific store, charge or payment. Money out is positive."

    @Generable struct Arguments {
        @Guide(description: "Merchant or words to look for, such as Costco")
        var query: String
    }

    func call(arguments: Arguments) async throws -> String {
        let q = arguments.query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 2 else { return "Give at least two characters to search for." }
        let r: SearchResponse = try await api.get("api/native/search", query: ["q": q])
        if r.transactions.isEmpty { return "No transactions match \"\(q)\"." }
        let total = r.transactions.reduce(0) { $0 + $1.normalizedAmount }
        sink.add(AnswerTable(
            title: "Recent “\(q)” transactions",
            rows: r.transactions.map { t in
                .init(name: t.displayName, detail: [t.date, t.categoryName].compactMap { $0 }.joined(separator: " · "), amount: Fmt.money(t.normalizedAmount))
            },
            footer: "\(r.transactions.count) most recent, \(Fmt.money(total)) together"))
        return "\(r.transactions.count) most recent matches for \"\(q)\", \(Fmt.money(total)) together, newest \(r.transactions[0].date). They are already shown to the user."
    }
}

@available(iOS 27.0, macOS 27.0, *)
struct HoldingsTool: Tool {
    let api: API
    let sink: AnswerSink
    let name = "getHoldings"
    let description = "Gets the user's investment holdings by current value. The app shows the list, so you receive a summary. Use for questions about investments, stocks, funds or the portfolio."

    @Generable struct Arguments {}

    func call(arguments: Arguments) async throws -> String {
        let rows: [HoldingLine] = try await api.get("api/native/investments/holdings")
        if rows.isEmpty { return "No investment holdings found." }
        let total = rows.reduce(0) { $0 + $1.currentValue }
        sink.add(AnswerTable(
            title: "Holdings",
            rows: rows.prefix(20).map { h in
                .init(name: h.securityName ?? h.ticker ?? "Unknown", detail: h.ticker, amount: Fmt.money(h.currentValue))
            },
            footer: "Portfolio \(Fmt.money(total))"))
        let top = rows.prefix(3).map { "\($0.securityName ?? $0.ticker ?? "Unknown") \(Fmt.money($0.currentValue))" }
        return "Portfolio total \(Fmt.money(total)) across \(rows.count) holdings. Largest: \(top.joined(separator: "; ")). The list is already shown to the user."
    }
}

@available(iOS 27.0, macOS 27.0, *)
enum AskTools {
    static func all(api: API, sink: AnswerSink) -> [any Tool] {
        [SubscriptionsTool(api: api, sink: sink), BudgetTool(api: api, sink: sink), SpendingTool(api: api, sink: sink),
         AccountsTool(api: api, sink: sink), FindTransactionsTool(api: api, sink: sink), HoldingsTool(api: api, sink: sink)]
    }
}
#endif
