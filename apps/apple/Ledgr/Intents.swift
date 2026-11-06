import AppIntents
import SwiftUI

/// Lets App Intents (Siri, Spotlight, Shortcuts) reach the running app's API client.
/// Intents run inside the app process, so LedgrApp registers its objects here at launch.
@MainActor
final class AppContext {
    static let shared = AppContext()
    var api: API?
    var actions: AppActions?
}

enum IntentFailure: LocalizedError {
    case notSignedIn
    var errorDescription: String? { "Open Ledgr and sign in first." }
}

@MainActor
private func readyAPI() async throws -> API {
    guard let api = AppContext.shared.api else { throw IntentFailure.notSignedIn }
    // Give the connection probe a moment on a cold launch.
    for _ in 0..<20 where api.auth == .unknown {
        await api.refreshAuth()
        if api.auth != .unknown { break }
        try? await Task.sleep(for: .milliseconds(250))
    }
    guard api.auth == .signedIn else { throw IntentFailure.notSignedIn }
    return api
}

// MARK: Questions

struct NetWorthIntent: AppIntent {
    static let title: LocalizedStringResource = "Net Worth"
    static let description = IntentDescription("Your current net worth, assets and debts.")

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try await readyAPI()
        let d: DashboardResponse = try await api.get("api/native/dashboard", query: ["range": "1M"])
        let s = d.summary
        return .result(dialog: "Your net worth is \(Fmt.moneyWhole(s.netWorth)): \(Fmt.moneyWhole(s.assets)) in assets and \(Fmt.moneyWhole(abs(s.liabilities))) in debt.")
    }
}

struct MonthSummaryIntent: AppIntent {
    static let title: LocalizedStringResource = "Monthly Summary"
    static let description = IntentDescription("Income, spending and net for this month.")

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try await readyAPI()
        let d: DashboardResponse = try await api.get("api/native/dashboard", query: ["range": "1M"])
        let s = d.summary
        return .result(dialog: "This month you've earned \(Fmt.moneyWhole(s.monthlyIncome)) and spent \(Fmt.moneyWhole(s.monthlyExpenses)), so your net is \(Fmt.moneyWhole(s.monthlyNet)).")
    }
}

struct SpendingIntent: AppIntent {
    static let title: LocalizedStringResource = "Spending This Month"
    static let description = IntentDescription("How much you've spent this month, overall or in one category.")

    @Parameter(title: "Category", description: "Leave empty for the top categories.")
    var category: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Spending in \(\.$category) this month")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try await readyAPI()
        let d: DashboardResponse = try await api.get("api/native/dashboard", query: ["range": "1M"])
        if let q = category?.trimmingCharacters(in: .whitespaces), !q.isEmpty {
            let hits = d.spending.filter { $0.categoryName.localizedCaseInsensitiveContains(q) }
            guard !hits.isEmpty else { return .result(dialog: "I don't see any spending in \(q) this month.") }
            let total = hits.reduce(0) { $0 + $1.total }
            return .result(dialog: "You've spent \(Fmt.money(total)) on \(hits.first!.categoryName) this month.")
        }
        let top = d.spending.sorted { $0.total > $1.total }.prefix(3)
        let list = top.map { "\($0.categoryName), \(Fmt.moneyWhole($0.total))" }.joined(separator: "; ")
        return .result(dialog: "You've spent \(Fmt.moneyWhole(d.summary.monthlyExpenses)) this month. Top categories: \(list).")
    }
}

struct BudgetStatusIntent: AppIntent {
    static let title: LocalizedStringResource = "Budget Status"
    static let description = IntentDescription("How much budget you have left this month, overall or in one category.")

    @Parameter(title: "Category", description: "Leave empty for the whole budget.")
    var category: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Budget left in \(\.$category)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try await readyAPI()
        let b: BudgetResponse = try await api.get("api/native/budgets")
        guard b.budget != nil else { return .result(dialog: "You haven't set up a budget for this month yet.") }
        if let q = category?.trimmingCharacters(in: .whitespaces), !q.isEmpty {
            let hit = b.groups.flatMap(\.categories).first { $0.categoryName.localizedCaseInsensitiveContains(q) }
            guard let c = hit else { return .result(dialog: "\(q) isn't in this month's budget.") }
            let text = c.remaining >= 0
                ? "You have \(Fmt.money(c.remaining)) left in \(c.categoryName): \(Fmt.money(c.spent)) spent of \(Fmt.money(c.limitAmount))."
                : "You're \(Fmt.money(-c.remaining)) over in \(c.categoryName): \(Fmt.money(c.spent)) spent of \(Fmt.money(c.limitAmount))."
            return .result(dialog: IntentDialog(stringLiteral: text))
        }
        let s = b.summary
        let text = s.totalRemaining >= 0
            ? "You have \(Fmt.moneyWhole(s.totalRemaining)) left of your \(Fmt.moneyWhole(s.totalBudgeted)) budget this month."
            : "You're \(Fmt.moneyWhole(-s.totalRemaining)) over your \(Fmt.moneyWhole(s.totalBudgeted)) budget this month."
        return .result(dialog: IntentDialog(stringLiteral: text))
    }
}

struct UpcomingBillsIntent: AppIntent {
    static let title: LocalizedStringResource = "Upcoming Bills"
    static let description = IntentDescription("Bills that are overdue or due soon.")

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try await readyAPI()
        let r: RecurringResponse = try await api.get("api/native/recurring")
        let late = r.groups.overdue
        let soon = r.groups.thisMonth.sorted { ($0.nextDate ?? "") < ($1.nextDate ?? "") }.prefix(4)
        if late.isEmpty && soon.isEmpty { return .result(dialog: "Nothing is due the rest of this month.") }
        var parts: [String] = []
        if !late.isEmpty {
            parts.append("\(late.count) overdue: " + late.prefix(3).map { "\($0.name), \(Fmt.money($0.amount))" }.joined(separator: "; "))
        }
        if !soon.isEmpty {
            parts.append("Coming up: " + soon.map { "\($0.name), \(Fmt.money($0.amount)) \($0.relativeDateLabel ?? "")" }.joined(separator: "; "))
        }
        return .result(dialog: IntentDialog(stringLiteral: parts.joined(separator: ". ") + "."))
    }
}

struct CategorizeTransactionIntent: AppIntent {
    static let title: LocalizedStringResource = "Categorize Transaction"
    static let description = IntentDescription("Puts an uncategorized transaction into a category, after you confirm.")

    @Parameter(title: "Merchant or name") var search: String
    @Parameter(title: "Category") var category: String

    static var parameterSummary: some ParameterSummary {
        Summary("Categorize \(\.$search) as \(\.$category)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try await readyAPI()
        let groups: [CategoryGroup] = try await api.get("api/native/categories")
        let all = groups.flatMap(\.categories)
        let q = category.trimmingCharacters(in: .whitespaces)
        let exact = all.filter { $0.name.caseInsensitiveCompare(q) == .orderedSame }
        let matches = exact.isEmpty ? all.filter { $0.name.localizedCaseInsensitiveContains(q) } : exact
        guard matches.count == 1, let cat = matches.first else {
            let text = matches.isEmpty ? "I couldn't find a category called \(q)." : "More than one category matches \(q). Say the full name."
            return .result(dialog: IntentDialog(stringLiteral: text))
        }
        let page: TxnPage = try await api.get("api/native/transactions", query: ["search": search, "needsReview": "1", "limit": "5"])
        let open = page.rows.filter { $0.categoryId == nil }
        guard open.count == 1, let txn = open.first else {
            let text = open.isEmpty
                ? "I found no uncategorized transactions matching \(search)."
                : "\(open.count) uncategorized transactions match \(search). Be more specific, or use the app."
            return .result(dialog: IntentDialog(stringLiteral: text))
        }
        try await requestConfirmation(result: .result(dialog: IntentDialog(stringLiteral: "Put \(txn.name) for \(Fmt.money(abs(txn.normalizedAmount))) in \(cat.name)?")))
        let _: Ok = try await api.patch("api/native/transactions/\(txn.id)", body: ["categoryId": cat.id])
        return .result(dialog: IntentDialog(stringLiteral: "Done. \(txn.name) is now in \(cat.name)."))
    }
}

struct PortfolioIntent: AppIntent {
    static let title: LocalizedStringResource = "Portfolio"
    static let description = IntentDescription("Your investment portfolio value and today's change.")

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try await readyAPI()
        let o: InvestmentsOverview = try await api.get("api/native/investments/overview", query: ["range": "1M"])
        let s = o.summary
        var text = "Your portfolio is worth \(Fmt.moneyWhole(s.totalValue))."
        if let day = s.dayChange {
            text += day >= 0 ? " Up \(Fmt.moneyWhole(day)) today." : " Down \(Fmt.moneyWhole(-day)) today."
        }
        if s.totalCostBasis > 0 {
            text += s.totalGainLoss >= 0 ? " Gain of \(Fmt.moneyWhole(s.totalGainLoss)) overall." : " Loss of \(Fmt.moneyWhole(-s.totalGainLoss)) overall."
        }
        return .result(dialog: IntentDialog(stringLiteral: text))
    }
}

struct FindTransactionsIntent: AppIntent {
    static let title: LocalizedStringResource = "Find Transactions"
    static let description = IntentDescription("Search your transactions by merchant or name.")

    @Parameter(title: "Search") var query: String

    static var parameterSummary: some ParameterSummary { Summary("Find transactions matching \(\.$query)") }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try await readyAPI()
        let page: TxnPage = try await api.get("api/native/transactions", query: ["search": query, "limit": "5"])
        guard !page.rows.isEmpty else { return .result(dialog: "No transactions match \(query).") }
        let lines = page.rows.map { "\($0.name), \(Fmt.money(abs($0.normalizedAmount))) on \(Fmt.dayHeader($0.date))" }
        let text = "Latest matches: " + lines.joined(separator: "; ") + "."
        return .result(dialog: IntentDialog(stringLiteral: text))
    }
}

struct ReviewQueueIntent: AppIntent {
    static let title: LocalizedStringResource = "Transactions to Review"
    static let description = IntentDescription("How many transactions still need your review.")

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try await readyAPI()
        let page: TxnPage = try await api.get("api/native/transactions", query: ["needsReview": "1", "limit": "50"])
        let n = page.rows.count
        if n == 0 { return .result(dialog: "You're all caught up. Nothing to review.") }
        let more = page.nextCursor != nil ? "at least " : ""
        return .result(dialog: "You have \(more)\(n) transactions to review.")
    }
}

// MARK: Opening the app

struct AddReceiptIntent: AppIntent {
    static let title: LocalizedStringResource = "Add Receipt"
    static let description = IntentDescription("Opens Ledgr's receipt scanner.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        #if os(iOS)
        AppContext.shared.actions?.showScanner = true
        #else
        AppContext.shared.actions?.showImporter = true
        #endif
        return .result()
    }
}

// MARK: Siri phrases

struct LedgrShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: NetWorthIntent(),
            phrases: ["What's my net worth in \(.applicationName)", "\(.applicationName) net worth"],
            shortTitle: "Net Worth", systemImageName: "chart.line.uptrend.xyaxis")
        AppShortcut(
            intent: MonthSummaryIntent(),
            phrases: ["How am I doing this month in \(.applicationName)", "\(.applicationName) monthly summary"],
            shortTitle: "This Month", systemImageName: "calendar")
        AppShortcut(
            intent: SpendingIntent(),
            phrases: ["How much did I spend in \(.applicationName)", "\(.applicationName) spending"],
            shortTitle: "Spending", systemImageName: "creditcard")
        AppShortcut(
            intent: BudgetStatusIntent(),
            phrases: ["How's my budget in \(.applicationName)", "\(.applicationName) budget left"],
            shortTitle: "Budget", systemImageName: "chart.pie")
        AppShortcut(
            intent: UpcomingBillsIntent(),
            phrases: ["What bills are due in \(.applicationName)", "\(.applicationName) upcoming bills"],
            shortTitle: "Bills Due", systemImageName: "calendar.badge.clock")
        AppShortcut(
            intent: CategorizeTransactionIntent(),
            phrases: ["Categorize a transaction in \(.applicationName)"],
            shortTitle: "Categorize", systemImageName: "tag")
        AppShortcut(
            intent: PortfolioIntent(),
            phrases: ["How are my investments in \(.applicationName)", "\(.applicationName) portfolio"],
            shortTitle: "Portfolio", systemImageName: "chart.line.uptrend.xyaxis")
        AppShortcut(
            intent: ReviewQueueIntent(),
            phrases: ["What needs review in \(.applicationName)", "\(.applicationName) review queue"],
            shortTitle: "To Review", systemImageName: "checklist")
        AppShortcut(
            intent: FindTransactionsIntent(),
            phrases: ["Find a transaction in \(.applicationName)"],
            shortTitle: "Find Transactions", systemImageName: "magnifyingglass")
        AppShortcut(
            intent: AddReceiptIntent(),
            phrases: ["Add a receipt in \(.applicationName)", "Scan a receipt with \(.applicationName)"],
            shortTitle: "Add Receipt", systemImageName: "doc.text.viewfinder")
    }
}
