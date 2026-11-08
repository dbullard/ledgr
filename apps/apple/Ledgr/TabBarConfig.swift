import SwiftUI

/// The screens that can sit in the iPhone's bottom tab bar. Anything not in the bar lives under More.
enum TabChoice: String, CaseIterable, Identifiable {
    case dashboard, transactions, accounts, budgets, recurring, investments, reports, receipts, items, categories, rules, importFile

    var id: String { rawValue }

    var title: String {
        switch self {
        case .dashboard: return "Dashboard"
        case .transactions: return "Transactions"
        case .accounts: return "Accounts"
        case .budgets: return "Budgets"
        case .recurring: return "Recurring"
        case .investments: return "Investments"
        case .reports: return "Reports"
        case .receipts: return "Receipts"
        case .items: return "Items"
        case .categories: return "Categories"
        case .rules: return "Rules"
        case .importFile: return "Import"
        }
    }

    var symbol: String {
        switch self {
        case .dashboard: return "square.grid.2x2"
        case .transactions: return "list.bullet"
        case .accounts: return "building.columns"
        case .budgets: return "chart.pie"
        case .recurring: return "repeat"
        case .investments: return "chart.line.uptrend.xyaxis"
        case .reports: return "chart.bar.xaxis"
        case .receipts: return "receipt"
        case .items: return "cart"
        case .categories: return "tag"
        case .rules: return "wand.and.stars"
        case .importFile: return "square.and.arrow.down"
        }
    }

    var section: AppSection {
        switch self {
        case .dashboard: return .dashboard
        case .transactions: return .transactions
        case .accounts: return .accounts
        case .budgets: return .budgets
        case .recurring: return .recurring
        case .investments: return .investments
        case .reports: return .reports
        case .receipts: return .receipts
        case .items: return .items
        case .categories: return .categories
        case .rules: return .rules
        case .importFile: return .importFile
        }
    }

    /// The screen itself, for the More list.
    @ViewBuilder var screen: some View {
        switch self {
        case .dashboard: DashboardView()
        case .transactions: TransactionsView()
        case .accounts: AccountsView()
        case .budgets: BudgetsView()
        case .recurring: RecurringView()
        case .investments: InvestmentsView()
        case .reports: ReportsView()
        case .receipts: ReceiptsView()
        case .items: ItemsView()
        case .categories: CategoriesView()
        case .rules: RulesView()
        case .importFile: ImportView()
        }
    }

    // MARK: Saved layout

    /// Four slots; the fifth tab is always More.
    static let maxTabs = 4
    static let defaults: [TabChoice] = [.dashboard, .transactions, .investments, .receipts]
    static let defaultRaw = defaults.map(\.rawValue).joined(separator: ",")

    static func decode(_ raw: String) -> [TabChoice] {
        var seen = Set<TabChoice>()
        let list = raw.split(separator: ",").compactMap { TabChoice(rawValue: String($0)) }.filter { seen.insert($0).inserted }
        let capped = Array(list.prefix(maxTabs))
        return capped.isEmpty ? defaults : capped
    }

    static func encode(_ tabs: [TabChoice]) -> String { tabs.map(\.rawValue).joined(separator: ",") }
}

/// Reorder, add and remove the screens in the bottom tab bar.
struct TabBarEditor: View {
    @AppStorage("tabBar") private var raw = TabChoice.defaultRaw

    private var tabs: [TabChoice] { TabChoice.decode(raw) }
    private var others: [TabChoice] { TabChoice.allCases.filter { !tabs.contains($0) } }

    var body: some View {
        List {
            Section {
                ForEach(tabs) { choice in
                    HStack(spacing: 12) {
                        Image(systemName: choice.symbol).frame(width: 24).foregroundStyle(Color.accentColor)
                        Text(choice.title)
                    }
                }
                .onMove { from, to in
                    var t = tabs
                    t.move(fromOffsets: from, toOffset: to)
                    raw = TabChoice.encode(t)
                }
                .onDelete { offsets in
                    var t = tabs
                    t.remove(atOffsets: offsets)
                    raw = TabChoice.encode(t)
                }
                if tabs.isEmpty { Text("Add at least one screen.").foregroundStyle(.secondary) }
            } header: {
                Text("In the tab bar")
            } footer: {
                Text("Up to \(TabChoice.maxTabs) screens, plus More. Drag to reorder, swipe to remove.")
            }

            Section("In More") {
                ForEach(others) { choice in
                    Button {
                        guard tabs.count < TabChoice.maxTabs else { return }
                        raw = TabChoice.encode(tabs + [choice])
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "plus.circle.fill").foregroundStyle(tabs.count < TabChoice.maxTabs ? Color.green : Color.secondary)
                            Image(systemName: choice.symbol).frame(width: 24).foregroundStyle(.secondary)
                            Text(choice.title).foregroundStyle(.primary)
                        }
                    }
                    .disabled(tabs.count >= TabChoice.maxTabs)
                }
            }

            Section {
                Button("Reset to default") { raw = TabChoice.defaultRaw }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.canvas)
        .navigationTitle("Tab bar")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .environment(\.editMode, .constant(.active))
        #endif
    }
}
