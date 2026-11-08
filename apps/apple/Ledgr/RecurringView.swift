import SwiftUI

struct RecurringItem: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let merchantName: String?
    let categoryName: String?
    let categoryIcon: String?
    let accountName: String?
    let averageAmount: Int?
    let lastAmount: Int?
    let frequency: String?
    let nextDate: String?
    let lastDate: String?
    let status: String
    let lifecycle: String
    let relativeDateLabel: String?

    var amount: Int { abs(averageAmount ?? lastAmount ?? 0) }
    var frequencyLabel: String {
        switch frequency {
        case "biweekly": return "Every 2 weeks"
        case "semimonthly": return "Twice a month"
        case .some(let f): return f.capitalized
        case nil: return ""
        }
    }
}

struct RecurringGroups: Codable {
    let overdue: [RecurringItem]
    let thisMonth: [RecurringItem]
    let future: [RecurringItem]
    let paused: [RecurringItem]
    let archived: [RecurringItem]
}

struct RecurringTotals: Codable {
    let monthlyIncome: Int
    let monthlyExpenses: Int
}

struct RecurringResponse: Codable {
    let groups: RecurringGroups
    let summary: RecurringTotals
}

private let recurringSpring = Animation.spring(response: 0.4, dampingFraction: 1)

struct RecurringView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var connection: Connection
    @State private var data: RecurringResponse?
    @State private var error: String?
    @State private var search = ""
    @State private var showCreate = false
    @State private var showArchived = false
    @State private var note: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var anim: Animation? { reduceMotion ? nil : recurringSpring }

    var body: some View {
        ScrollView {
            if let data {
                VStack(spacing: 16) {
                    header(data.summary)
                    if let note { Text(note).font(.footnote).foregroundStyle(Color.alert).frame(maxWidth: .infinity, alignment: .leading) }
                    section("Overdue", data.groups.overdue, tint: .red)
                    section("Due this month", data.groups.thisMonth)
                    section("Later", data.groups.future)
                    section("Paused & inactive", data.groups.paused, muted: true)
                    archivedSection(data.groups.archived)
                    if allItems(data).isEmpty {
                        ContentUnavailableView {
                            Label("No recurring items", systemImage: "repeat")
                        } description: {
                            Text("Add a bill or subscription, or mark a transaction as recurring from its page.")
                        } actions: {
                            Button("Add recurring expense") { showCreate = true }.buttonStyle(.borderedProminent)
                        }
                        .padding(.top, 40)
                    } else if !search.isEmpty && filteredCount(data) == 0 {
                        ContentUnavailableView.search(text: search).padding(.top, 40)
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
        .navigationTitle("Recurring")
        .searchable(text: $search, prompt: "Search recurring")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showCreate = true } label: { Image(systemName: "plus") }.help("Add recurring expense")
            }
        }
        .refreshable { await api.syncBanks(); await load() }
        .task(id: connection.active) { await load() }
        .sheet(isPresented: $showCreate) {
            RecurringCreateSheet { await load() }
                .presentationDetents([.medium])
        }
    }

    private func allItems(_ d: RecurringResponse) -> [RecurringItem] {
        let g = d.groups
        return g.overdue + g.thisMonth + g.future + g.paused + g.archived
    }

    private func filteredCount(_ d: RecurringResponse) -> Int { filtered(allItems(d)).count }

    private func filtered(_ items: [RecurringItem]) -> [RecurringItem] {
        let q = search.trimmingCharacters(in: .whitespaces)
        return q.isEmpty ? items : items.filter { $0.name.localizedCaseInsensitiveContains(q) }
    }

    private func header(_ s: RecurringTotals) -> some View {
        HStack(spacing: 12) {
            tile("Recurring spend", "\(Fmt.moneyWhole(s.monthlyExpenses))/mo", .primary)
            if s.monthlyIncome > 0 { tile("Recurring income", "\(Fmt.moneyWhole(s.monthlyIncome))/mo", Color.income) }
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

    private func row(_ item: RecurringItem, tint: Color?, muted: Bool) -> some View {
        NavigationLink(value: item) {
            RecurringRow(item: item, tint: tint, muted: muted) { status in Task { await setStatus(item, status) } }
        }
        .buttonStyle(.plain)
    }

    private func section(_ title: String, _ items: [RecurringItem], tint: Color? = nil, muted: Bool = false) -> some View {
        let rows = filtered(items)
        return Group {
            if !rows.isEmpty {
                Card(title, trailing: AnyView(countBadge(rows.count, tint: tint))) {
                    ForEach(rows) { item in
                        row(item, tint: tint, muted: muted)
                        if item.id != rows.last?.id { Divider() }
                    }
                }
                .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .top)))
            }
        }
    }

    /// Archived items are out of the way: one quiet line that opens in place.
    private func archivedSection(_ items: [RecurringItem]) -> some View {
        let rows = filtered(items)
        let open = showArchived || !search.isEmpty
        return Group {
            if !rows.isEmpty {
                Card {
                    Button {
                        withAnimation(anim) { showArchived.toggle() }
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "archivebox").foregroundStyle(.secondary)
                            Text("Archived").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                            countBadge(rows.count, tint: nil)
                            Spacer()
                            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                                .rotationEffect(.degrees(open ? 90 : 0))
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Archived, \(rows.count) items")
                    .accessibilityHint(open ? "Collapse" : "Expand")
                    if open {
                        Text("Archived items stop appearing in reminders and totals. Restore one to bring it back.")
                            .font(.footnote).foregroundStyle(.secondary)
                        ForEach(rows) { item in
                            row(item, tint: nil, muted: true)
                            if item.id != rows.last?.id { Divider() }
                        }
                    }
                }
                .transition(.opacity)
            }
        }
    }

    private func countBadge(_ n: Int, tint: Color?) -> some View {
        Text("\(n)").font(.caption.weight(.semibold)).monospacedDigit()
            .foregroundStyle(tint ?? .secondary)
            .padding(.horizontal, 7).padding(.vertical, 1)
            .background((tint ?? Color.secondary).opacity(0.14), in: Capsule())
    }

    private func setStatus(_ item: RecurringItem, _ status: String) async {
        do {
            let _: Ok = try await api.patch("api/native/recurring/\(item.id)", body: ["status": status])
            note = nil
            await load()
        } catch APIError.unauthorized {
        } catch { note = error.localizedDescription }
    }

    private func load() async {
        do {
            let fresh: RecurringResponse = try await api.get("api/native/recurring")
            withAnimation(anim) { data = fresh }
            error = nil
        } catch APIError.unauthorized {
        } catch {
            if data == nil { self.error = error.localizedDescription }
        }
    }
}

struct RecurringRow: View {
    let item: RecurringItem
    var tint: Color?
    /// Paused and archived items sit back visually.
    var muted = false
    /// Changes the item's status from the row itself (also offered in the context menu).
    var onStatus: ((String) -> Void)?

    private var subtitle: some View {
        HStack(spacing: 4) {
            if item.lifecycle == "archived" {
                if let last = item.lastDate { Text("Last paid \(Fmt.shortDate(last))") } else { Text("Archived") }
            } else if item.lifecycle == "paused" {
                Text("Paused")
            } else if muted {
                // Detected as stopped: no recent payments, though nothing was paused by hand.
                if let last = item.lastDate { Text("Inactive · last paid \(Fmt.shortDate(last))") } else { Text("Inactive") }
            } else if let label = item.relativeDateLabel {
                Text(label).foregroundStyle(tint ?? .secondary)
            }
            if !item.frequencyLabel.isEmpty { Text("· \(item.frequencyLabel)") }
        }
        .font(.caption).foregroundStyle(.secondary)
    }

    var body: some View {
        HStack(spacing: 12) {
            CategoryBadge(icon: item.categoryIcon ?? "repeat", categoryId: nil)
                .opacity(muted ? 0.55 : 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).font(.body.weight(.medium)).lineLimit(1)
                    .foregroundStyle(muted ? Color.secondary : Color.primary)
                subtitle
            }
            Spacer(minLength: 8)
            if muted, let onStatus {
                switch item.lifecycle {
                case "archived": Button("Restore") { onStatus("active") }.buttonStyle(.bordered).controlSize(.small)
                case "paused": Button("Resume") { onStatus("active") }.buttonStyle(.bordered).controlSize(.small)
                default: Button("Archive") { onStatus("archived") }.buttonStyle(.bordered).controlSize(.small)
                }
            }
            Text(Fmt.money(item.amount)).font(.body.monospacedDigit().weight(.medium))
                .foregroundStyle(muted ? Color.secondary : Color.primary)
        }
        .contentShape(Rectangle())
        .contextMenu {
            if let onStatus {
                if item.lifecycle == "active" {
                    Button { onStatus("paused") } label: { Label("Pause", systemImage: "pause.circle") }
                    Button { onStatus("archived") } label: { Label("Archive", systemImage: "archivebox") }
                } else {
                    Button { onStatus("active") } label: { Label(item.lifecycle == "archived" ? "Restore" : "Resume", systemImage: "arrow.uturn.backward.circle") }
                    if item.lifecycle == "paused" { Button { onStatus("archived") } label: { Label("Archive", systemImage: "archivebox") } }
                }
            }
        }
    }
}

struct RecurringDetailView: View {
    let item: RecurringItem
    @EnvironmentObject var api: API
    @Environment(\.dismiss) private var dismiss
    @State private var txns: [Txn] = []
    @State private var loaded = false
    @State private var note: String?
    @State private var showAllHistory = false

    private var statusLabel: (text: String, color: Color) {
        switch item.lifecycle {
        case "paused": return ("Paused", Color.alert)
        case "archived": return ("Archived", Color.secondary)
        default: return ("Active", Color.income)
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Card {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text(item.frequencyLabel).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                            Spacer()
                            Text(statusLabel.text).font(.caption.weight(.semibold)).foregroundStyle(statusLabel.color)
                                .padding(.horizontal, 9).padding(.vertical, 3)
                                .background(statusLabel.color.opacity(0.14), in: Capsule())
                        }
                        Text(Fmt.money(item.amount)).font(.system(size: 40, weight: .bold, design: .rounded)).monospacedDigit().tracking(-0.5)
                            .foregroundStyle(item.lifecycle == "archived" ? Color.secondary : Color.primary)
                        VStack(alignment: .leading, spacing: 6) {
                            if item.lifecycle == "archived" {
                                if let last = item.lastDate { Label("Last paid \(Fmt.shortDate(last))", systemImage: "clock") }
                            } else if let next = item.nextDate {
                                Label("Next \(Fmt.shortDate(next))" + (item.relativeDateLabel.map { " · \($0)" } ?? ""), systemImage: "calendar")
                            }
                            if let cat = item.categoryName { Label(cat, systemImage: "tag") }
                            if let acct = item.accountName { Label(acct, systemImage: "building.columns") }
                        }
                        .font(.footnote).foregroundStyle(.secondary)
                    }
                    actions
                    if let note { Text(note).font(.caption).foregroundStyle(Color.alert) }
                }
                Card("Payment history", trailing: AnyView(Text(txns.isEmpty ? "" : "\(txns.count)").font(.footnote).foregroundStyle(.secondary))) {
                    if txns.isEmpty { Text(loaded ? "No linked transactions" : "Loading…").foregroundStyle(.secondary) }
                    let shown = showAllHistory ? txns : Array(txns.prefix(6))
                    ForEach(shown) { txn in
                        NavigationLink(value: txn) { TxnRow(txn: txn) }.buttonStyle(.plain)
                        if txn.id != shown.last?.id { Divider() }
                    }
                    if txns.count > 6 {
                        Button(showAllHistory ? "Show fewer" : "Show all \(txns.count)") {
                            withAnimation(recurringSpring) { showAllHistory.toggle() }
                        }
                        .buttonStyle(.plain).foregroundStyle(Color.accentColor).font(.subheadline.weight(.medium))
                    }
                }
            }
            .padding()
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
        }
        .background(Color.canvas)
        .navigationTitle(item.name)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task {
            if let rows: [Txn] = try? await api.get("api/native/recurring/\(item.id)/transactions") { txns = rows }
            loaded = true
        }
    }

    /// One clear next step per state. Pausing and archiving are reversible, so neither is styled as destructive.
    @ViewBuilder private var actions: some View {
        HStack(spacing: 10) {
            switch item.lifecycle {
            case "active":
                Button { Task { await set("paused") } } label: { Label("Pause", systemImage: "pause.circle").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered)
                Button { Task { await set("archived") } } label: { Label("Archive", systemImage: "archivebox").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered)
            case "paused":
                Button { Task { await set("active") } } label: { Label("Resume", systemImage: "play.circle").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent)
                Button { Task { await set("archived") } } label: { Label("Archive", systemImage: "archivebox").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered)
            default:
                Button { Task { await set("active") } } label: { Label("Restore", systemImage: "arrow.uturn.backward.circle").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent)
            }
        }
        .controlSize(.large)
    }

    private func set(_ status: String) async {
        do {
            let _: Ok = try await api.patch("api/native/recurring/\(item.id)", body: ["status": status])
            dismiss()
        } catch { note = error.localizedDescription }
    }
}

struct RecurringCreateSheet: View {
    let onDone: () async -> Void
    @EnvironmentObject var api: API
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var amount = ""
    @State private var frequency = "monthly"
    @State private var next = Date()
    @State private var error: String?
    @State private var working = false

    private var cents: Int? {
        let cleaned = amount.replacingOccurrences(of: "$", with: "").replacingOccurrences(of: ",", with: "")
        guard let v = Double(cleaned.trimmingCharacters(in: .whitespaces)), v >= 0 else { return nil }
        return Int((v * 100).rounded())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("New recurring expense").font(.title3.weight(.semibold))
            TextField("Name (e.g. Netflix)", text: $name).textFieldStyle(.roundedBorder)
            TextField("Amount", text: $amount).textFieldStyle(.roundedBorder)
                #if os(iOS)
                .keyboardType(.decimalPad)
                #endif
            Picker("Frequency", selection: $frequency) {
                ForEach(["weekly", "biweekly", "semimonthly", "monthly", "yearly"], id: \.self) { Text($0.capitalized).tag($0) }
            }
            DatePicker("Next date", selection: $next, displayedComponents: .date)
            if let error { Text(error).font(.caption).foregroundStyle(Color.alert) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Add") { Task { await save() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || cents == nil || working)
            }
        }
        .padding(20)
    }

    private func save() async {
        guard let cents else { return }
        working = true
        defer { working = false }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        do {
            try await api.post("api/native/recurring", body: ["name": name, "amount": cents, "frequency": frequency, "nextDate": f.string(from: next)])
            await onDone()
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
