import SwiftUI

enum AppSection: Hashable, CaseIterable {
    case dashboard, transactions, receipts, items, more
}

/// Pages that don't have a native screen yet open the real web app.
struct WebPage: Identifiable, Hashable {
    let title: String
    let path: String
    let symbol: String
    var id: String { path }

    static let all: [WebPage] = [
        WebPage(title: "Accounts", path: "/accounts", symbol: "building.columns"),
        WebPage(title: "Budgets", path: "/budgets", symbol: "chart.pie"),
        WebPage(title: "Reports", path: "/reports", symbol: "chart.bar.xaxis"),
        WebPage(title: "Recurring", path: "/recurrings", symbol: "repeat"),
        WebPage(title: "Investments", path: "/investments", symbol: "chart.line.uptrend.xyaxis"),
        WebPage(title: "Categories", path: "/categories", symbol: "tag"),
        WebPage(title: "Rules", path: "/rules", symbol: "wand.and.stars"),
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
                    Label("Receipts", systemImage: "receipt").tag(AppSection.receipts)
                    Label("Items", systemImage: "cart").tag(AppSection.items)
                }
                Section("More") {
                    Label("Full app & settings", systemImage: "ellipsis.circle").tag(AppSection.more)
                }
            }
            .navigationSplitViewColumnWidth(min: 190, ideal: 210)
        } detail: {
            detail(for: section ?? .dashboard)
        }
        #else
        TabView(selection: Binding(get: { section ?? .dashboard }, set: { section = $0 })) {
            detail(for: .dashboard).tabItem { Label("Dashboard", systemImage: "square.grid.2x2") }.tag(AppSection.dashboard)
            detail(for: .transactions).tabItem { Label("Transactions", systemImage: "list.bullet") }.tag(AppSection.transactions)
            detail(for: .receipts).tabItem { Label("Receipts", systemImage: "receipt") }
                .badge(queue.items.count).tag(AppSection.receipts)
            detail(for: .items).tabItem { Label("Items", systemImage: "cart") }.tag(AppSection.items)
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
                case .receipts: ReceiptsView()
                case .items: ItemsView()
                case .more: MoreView()
                }
            }
            .navigationDestination(for: Txn.self) { TransactionDetailView(initial: $0) }
            .navigationDestination(for: WebPage.self) { WebPageView(page: $0) }
            .toolbar {
                ToolbarItem(placement: .primaryAction) { AddReceiptMenu() }
            }
            .statusToolbar()
        }
    }
}
