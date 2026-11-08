import SwiftUI

enum AppSection: Hashable {
    case dashboard, transactions, accounts, budgets, recurring, investments, reports, categories, rules, receipts, items, importFile, more
    case web(WebPage)
}

/// Pages that don't have a native screen yet open the real web app.
struct WebPage: Identifiable, Hashable {
    let title: String
    let path: String
    let symbol: String
    var id: String { path }

    static let all: [WebPage] = [
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
                NavigationLink { AccountsView() } label: { Label("Accounts", systemImage: "building.columns") }
                NavigationLink { ReportsView() } label: { Label("Reports", systemImage: "chart.bar.xaxis") }
                NavigationLink { CategoriesView() } label: { Label("Categories", systemImage: "tag") }
                NavigationLink { RulesView() } label: { Label("Rules", systemImage: "wand.and.stars") }
                NavigationLink { ItemsView() } label: { Label("Items", systemImage: "cart") }
                NavigationLink { ImportView() } label: { Label("Import", systemImage: "square.and.arrow.down") }
            }

            Section("This app") {
                NavigationLink { AccountSettingsView() } label: { Label("Settings", systemImage: "gearshape") }
                Button { actions.showSettings = true } label: { Label("Server addresses", systemImage: "network") }
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
    @EnvironmentObject var actions: AppActions

    func body(content: Content) -> some View {
        content.toolbar {
            ToolbarItem(placement: .navigation) {
                Button { actions.showSettings = true } label: {
                Label(connection.mode.label, systemImage: connection.mode.symbol)
                    .labelStyle(.titleAndIcon)
                    .font(.footnote)
                    .fixedSize()
                    .padding(.horizontal, 6)
                    .help("Connected via \(connection.mode.label). Click to change server addresses.")
                }
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
    @State private var waiting = 0
    @EnvironmentObject var queue: UploadQueue
    @EnvironmentObject var api: API
    @EnvironmentObject var connection: Connection

    /// Receipts on the server still waiting for a transaction (re-matched on the way).
    private func refreshWaiting() async {
        if let list: [UnmatchedReceipt] = try? await api.get("api/native/receipts") { waiting = list.count }
    }

    var body: some View {
        content
            .task(id: "\(connection.active?.absoluteString ?? "")|\(queue.items.count)|\(queue.uploading)|\(section == .receipts)") {
                await refreshWaiting()
            }
            .task(id: connection.active) { await CategoryStyles.shared.refresh(api) }
            .overlay(alignment: .bottom) { SimilarCategoryBanner() }
    }

    @ViewBuilder private var content: some View {
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
                    Label("Reports", systemImage: "chart.bar.xaxis").tag(AppSection.reports)
                    Label("Receipts", systemImage: "receipt").badge(waiting).tag(AppSection.receipts)
                    Label("Items", systemImage: "cart").tag(AppSection.items)
                }
                Section("Organize") {
                    Label("Categories", systemImage: "tag").tag(AppSection.categories)
                    Label("Rules", systemImage: "wand.and.stars").tag(AppSection.rules)
                }
                Section("Manage") {
                    Label("Import", systemImage: "square.and.arrow.down").tag(AppSection.importFile)
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
            detail(for: .dashboard).tabItem { Label("Dashboard", systemImage: "square.grid.2x2").labelStyle(.iconOnly) }.tag(AppSection.dashboard)
            detail(for: .transactions).tabItem { Label("Transactions", systemImage: "list.bullet").labelStyle(.iconOnly) }.tag(AppSection.transactions)
            detail(for: .investments).tabItem { Label("Investments", systemImage: "chart.line.uptrend.xyaxis").labelStyle(.iconOnly) }.tag(AppSection.investments)
            detail(for: .receipts).tabItem { Label("Receipts", systemImage: "receipt").labelStyle(.iconOnly) }
                .badge(queue.items.count + waiting).tag(AppSection.receipts)
            detail(for: .more).tabItem { Label("More", systemImage: "ellipsis.circle").labelStyle(.iconOnly) }.tag(AppSection.more)
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
                case .reports: ReportsView()
                case .categories: CategoriesView()
                case .rules: RulesView()
                case .receipts: ReceiptsView()
                case .items: ItemsView()
                case .importFile: ImportView()
                case .more:
                    #if os(macOS)
                    AccountSettingsView()
                    #else
                    MoreView()
                    #endif
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
