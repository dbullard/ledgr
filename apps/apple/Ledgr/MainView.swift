import SwiftUI

enum AppSection: Hashable {
    case dashboard, transactions, accounts, budgets, recurring, investments, categories, rules, receipts, items, more
    case web(WebPage)
}

/// Pages that don't have a native screen yet open the real web app.
struct WebPage: Identifiable, Hashable {
    let title: String
    let path: String
    let symbol: String
    var id: String { path }

    static let all: [WebPage] = [
        WebPage(title: "Reports", path: "/reports", symbol: "chart.bar.xaxis"),
        WebPage(title: "Import", path: "/import", symbol: "square.and.arrow.down"),
        WebPage(title: "Web settings", path: "/settings", symbol: "gearshape"),
    ]
}

struct WebPageView: View {
    let page: WebPage
    @EnvironmentObject var web: WebModel

    var body: some View {
        LedgrWebView(model: web)
            .navigationTitle(page.title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .onAppear { web.show(path: page.path) }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { web.reload() } label: { Image(systemName: "arrow.clockwise") }
                }
            }
    }
}

struct MoreView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var actions: AppActions

    var body: some View {
        List {
            Section("Native") {
                NavigationLink { BudgetsView() } label: { Label("Budgets", systemImage: "chart.pie") }
                NavigationLink { RecurringView() } label: { Label("Recurring", systemImage: "repeat") }
                NavigationLink { InvestmentsView() } label: { Label("Investments", systemImage: "chart.line.uptrend.xyaxis") }
                NavigationLink { CategoriesView() } label: { Label("Categories", systemImage: "tag") }
                NavigationLink { RulesView() } label: { Label("Rules", systemImage: "wand.and.stars") }
                NavigationLink { ItemsView() } label: { Label("Items", systemImage: "cart") }
            }
            Section("Full app") {
                ForEach(WebPage.all) { page in
                    NavigationLink(value: page) { Label(page.title, systemImage: page.symbol) }
                }
            }
            Section("This app") {
                Button { actions.showSettings = true } label: { Label("Server settings", systemImage: "network") }
                Button(role: .destructive) { Task { await api.signOut() } } label: {
                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.canvas)
        .navigationTitle("More")
    }
}

/// Status strip: which address is in use, plus quick receipt upload.
struct StatusToolbar: ViewModifier {
    @EnvironmentObject var connection: Connection
    @EnvironmentObject var queue: UploadQueue

    func body(content: Content) -> some View {
        content.toolbar {
            ToolbarItem(placement: .navigation) {
                Label(connection.mode.label, systemImage: connection.mode.symbol)
                    .labelStyle(.titleAndIcon)
                    .font(.footnote)
                    .fixedSize()
                    .foregroundStyle(connection.mode == .offline ? .red : .secondary)
            }
        }
    }
}

extension View {
    func statusToolbar() -> some View { modifier(StatusToolbar()) }
}

struct MainView: View {
    @State private var section: AppSection? = .dashboard
    @EnvironmentObject var queue: UploadQueue

    var body: some View {
        #if os(macOS)
        NavigationSplitView {
            List(selection: $section) {
                Section("Overview") {
                    Label("Dashboard", systemImage: "square.grid.2x2").tag(AppSection.dashboard)
                    Label("Transactions", systemImage: "list.bullet").tag(AppSection.transactions)
                    Label("Accounts", systemImage: "building.columns").tag(AppSection.accounts)
                    Label("Budgets", systemImage: "chart.pie").tag(AppSection.budgets)
                    Label("Recurring", systemImage: "repeat").tag(AppSection.recurring)
                    Label("Investments", systemImage: "chart.line.uptrend.xyaxis").tag(AppSection.investments)
                    Label("Receipts", systemImage: "receipt").tag(AppSection.receipts)
                    Label("Items", systemImage: "cart").tag(AppSection.items)
                }
                Section("Organize") {
                    Label("Categories", systemImage: "tag").tag(AppSection.categories)
                    Label("Rules", systemImage: "wand.and.stars").tag(AppSection.rules)
                }
                Section("Manage") {
                    ForEach(WebPage.all.filter { ["/reports", "/import"].contains($0.path) }) { page in
                        Label(page.title, systemImage: page.symbol).tag(AppSection.web(page))
                    }
                }
                Section {
                    Label("Settings", systemImage: "gearshape").tag(AppSection.more)
                }
            }
            .navigationSplitViewColumnWidth(min: 200, ideal: 220)
            .scrollContentBackground(.hidden)
            .background(Color.canvas)
        } detail: {
            detail(for: section ?? .dashboard)
        }
        #else
        TabView(selection: Binding(get: { section ?? .dashboard }, set: { section = $0 })) {
            detail(for: .dashboard).tabItem { Label("Dashboard", systemImage: "square.grid.2x2") }.tag(AppSection.dashboard)
            detail(for: .transactions).tabItem { Label("Transactions", systemImage: "list.bullet") }.tag(AppSection.transactions)
            detail(for: .accounts).tabItem { Label("Accounts", systemImage: "building.columns") }.tag(AppSection.accounts)
            detail(for: .receipts).tabItem { Label("Receipts", systemImage: "receipt") }
                .badge(queue.items.count).tag(AppSection.receipts)
            detail(for: .more).tabItem { Label("More", systemImage: "ellipsis.circle") }.tag(AppSection.more)
        }
        #endif
    }

    @ViewBuilder
    private func detail(for section: AppSection) -> some View {
        NavigationStack {
            Group {
                switch section {
                case .dashboard: DashboardView()
                case .transactions: TransactionsView()
                case .accounts: AccountsView()
                case .budgets: BudgetsView()
                case .recurring: RecurringView()
                case .investments: InvestmentsView()
                case .categories: CategoriesView()
                case .rules: RulesView()
                case .receipts: ReceiptsView()
                case .items: ItemsView()
                case .more: MoreView()
                case .web(let page): WebPageView(page: page)
                }
            }
            .navigationDestination(for: RecurringItem.self) { RecurringDetailView(item: $0) }
            .navigationDestination(for: AccountRowModel.self) { AccountDetailView(account: $0) }
            .navigationDestination(for: Txn.self) { TransactionDetailView(initial: $0) }
            .navigationDestination(for: WebPage.self) { WebPageView(page: $0) }
            .toolbar {
                ToolbarItem(placement: .primaryAction) { AddReceiptMenu() }
            }
            .statusToolbar()
        }
    }
}
