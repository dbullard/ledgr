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
    let matchName: String?
    let matchMinAmount: Int?
    let matchMaxAmount: Int?
    let matchDayOfMonth: Int?

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

struct SubscriptionSuggestion: Codable, Identifiable, Hashable {
    let key: String
    let name: String
    let matchName: String
    let averageAmount: Int
    let minAmount: Int
    let maxAmount: Int
    let frequency: String
    let lastDate: String
    let nextDate: String
    let count: Int
    let confidence: Double
    var id: String { key }

    var frequencyLabel: String {
        switch frequency {
        case "biweekly": return "Every 2 weeks"
        default: return frequency.capitalized
        }
    }
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
    @State private var showPaused = false
    @State private var suggestions: [SubscriptionSuggestion] = []
    @State private var verdicts: [String: (name: String, ok: Bool)] = [:]
    @State private var dismissed = Set(UserDefaults.standard.stringArray(forKey: "recurring.dismissed") ?? [])
    @State private var showAllSuggestions = false
    @State private var adding: Set<String> = []
    @State private var note: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var anim: Animation? { reduceMotion ? nil : recurringSpring }

    var body: some View {
        ScrollView {
            if let data {
                VStack(spacing: 16) {
                    header(data.summary)
                    if let note { Text(note).font(.footnote).foregroundStyle(Color.alert).frame(maxWidth: .infinity, alignment: .leading) }
                    suggestedSection
                    section("Overdue", data.groups.overdue, tint: .red)
                    section("Due this month", data.groups.thisMonth)
                    section("Later", data.groups.future)
                    collapsible("Paused & inactive", icon: "pause.circle", items: data.groups.paused, isOpen: $showPaused,
                                note: "Paused or stopped bills stay out of reminders and totals. Resume one, or archive it to tidy up.")
                    collapsible("Archived", icon: "archivebox", items: data.groups.archived, isOpen: $showArchived,
                                note: "Archived items stop appearing in reminders and totals. Restore one to bring it back.")
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
                LoadingPlaceholder().padding(.top, 80)
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
        .task(id: suggestions.map(\.key)) { await judge() }
        .sheet(isPresented: $showCreate) {
            RecurringCreateSheet { await load() }
                .presentationDetents([.medium])
        }
    }

    // MARK: Suggested subscriptions

    /// Detected repeats first; ones the on-device model judges to be habit spending go last.
    private var visibleSuggestions: [SubscriptionSuggestion] {
        suggestions.filter { !dismissed.contains($0.key) && (search.isEmpty || $0.name.localizedCaseInsensitiveContains(search)) }
            .sorted { (verdicts[$0.key]?.ok ?? true ? 0 : 1) < (verdicts[$1.key]?.ok ?? true ? 0 : 1) }
    }

    @ViewBuilder private var suggestedSection: some View {
        let all = visibleSuggestions
        let shown = showAllSuggestions ? all : Array(all.prefix(3))
        if !all.isEmpty {
            Card("Suggested", trailing: AnyView(
                HStack(spacing: 6) {
                    if OnDeviceAI.isAvailable { Image(systemName: "sparkles").foregroundStyle(Color.accentColor) }
                    countBadge(all.count, tint: .accentColor)
                })) {
                Text("Charges that repeat on a schedule and aren\u{2019}t tracked yet.")
                    .font(.footnote).foregroundStyle(.secondary)
                ForEach(shown) { s in
                    suggestionRow(s)
                    if s.id != shown.last?.id { Divider() }
                }
                if all.count > 3 {
                    Button(showAllSuggestions ? "Show fewer" : "Show all \(all.count)") {
                        withAnimation(anim) { showAllSuggestions.toggle() }
                    }
                    .buttonStyle(.plain).foregroundStyle(Color.accentColor).font(.subheadline.weight(.medium))
                }
            }
            .transition(.opacity)
        }
    }

    private func suggestionRow(_ s: SubscriptionSuggestion) -> some View {
        let verdict = verdicts[s.key]
        let title = verdict?.name ?? s.name
        let busy = adding.contains(s.key)
        return HStack(spacing: 12) {
            CategoryBadge(icon: "sparkles", categoryId: nil).opacity(verdict?.ok == false ? 0.55 : 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.medium)).lineLimit(1)
                Text("\(s.frequencyLabel) \u{00B7} seen \(s.count)\u{00D7} \u{00B7} last \(Fmt.shortDate(s.lastDate))" + (verdict?.ok == false ? " \u{00B7} maybe not" : ""))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 1) {
                Text(Fmt.money(s.averageAmount)).font(.body.monospacedDigit().weight(.medium))
                if s.minAmount != s.maxAmount {
                    Text("\(Fmt.moneyWhole(s.minAmount))\u{2013}\(Fmt.moneyWhole(s.maxAmount))").font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            Button { Task { await accept(s, name: title) } } label: {
                if busy { ProgressView().controlSize(.small) } else { Text("Add") }
            }
            .buttonStyle(.borderedProminent).controlSize(.small).disabled(busy)
            Button { dismiss(s) } label: { Image(systemName: "xmark").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary).frame(width: 24, height: 24) }
                .buttonStyle(.plain).accessibilityLabel("Dismiss suggestion")
        }
        .contextMenu {
            Button { dismiss(s) } label: { Label("Not a subscription", systemImage: "xmark.circle") }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Dismiss suggestion") { dismiss(s) }
    }

    private func dismiss(_ s: SubscriptionSuggestion) {
        withAnimation(anim) { _ = dismissed.insert(s.key) }
        UserDefaults.standard.set(Array(dismissed), forKey: "recurring.dismissed")
    }

    private func accept(_ s: SubscriptionSuggestion, name: String) async {
        adding.insert(s.key)
        defer { adding.remove(s.key) }
        do {
            try await api.post("api/native/recurring", body: [
                "name": name, "amount": s.averageAmount, "frequency": s.frequency, "nextDate": s.nextDate,
                "matchName": s.matchName, "matchMinAmount": s.minAmount, "matchMaxAmount": s.maxAmount,
            ])
            note = nil
            withAnimation(anim) { suggestions.removeAll { $0.key == s.key } }
            await load()
        } catch APIError.unauthorized {
        } catch { note = error.localizedDescription }
    }

    /// Asks the on-device model, once per suggestion, for a clean name and a subscription check.
    private func judge() async {
        guard OnDeviceAI.isAvailable else { return }
        for s in suggestions where verdicts[s.key] == nil {
            if Task.isCancelled { return }
            if let v = await OnDeviceAI.judgeSubscription(rawName: s.name, frequency: s.frequency, cents: s.averageAmount) {
                verdicts[s.key] = (v.name, v.isSubscription)
            }
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
                .transition(.opacity)
            }
        }
    }

    /// Quiet sections (paused, archived): one line that opens in place.
    private func collapsible(_ title: String, icon: String, items: [RecurringItem], isOpen: Binding<Bool>, note: String) -> some View {
        let rows = filtered(items)
        let open = isOpen.wrappedValue || !search.isEmpty
        return Group {
            if !rows.isEmpty {
                Card {
                    Button {
                        withAnimation(anim) { isOpen.wrappedValue.toggle() }
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: icon).foregroundStyle(.secondary)
                            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                            countBadge(rows.count, tint: nil)
                            Spacer()
                            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                                .rotationEffect(.degrees(open ? 90 : 0))
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(title), \(rows.count) items")
                    .accessibilityHint(open ? "Collapse" : "Expand")
                    if open {
                        Text(note).font(.footnote).foregroundStyle(.secondary)
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
        if data == nil, let c: RecurringResponse = api.cached("api/native/recurring") { data = c }
        do {
            let fresh: RecurringResponse = try await api.get("api/native/recurring")
            let first = data == nil
            withAnimation(first ? nil : anim) { data = fresh }
            error = nil
            if let found: [SubscriptionSuggestion] = try? await api.get("api/native/recurring/suggestions") {
                withAnimation(first ? nil : anim) { suggestions = found }
            }
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
    @State private var showEdit = false
    @State private var rules: RecurringItem?

    private var current: RecurringItem { rules ?? item }

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
                rulesCard
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
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Edit") { showEdit = true }
            }
        }
        .sheet(isPresented: $showEdit) {
            RecurringEditSheet(item: current) { await reload() }
                #if os(iOS)
                .presentationDetents([.large])
                #endif
        }
        .task { await reload() }
    }

    private func reload() async {
        if let rows: [Txn] = try? await api.get("api/native/recurring/\(item.id)/transactions") { txns = rows }
        if let fresh: RecurringResponse = try? await api.get("api/native/recurring") {
            let g = fresh.groups
            rules = (g.overdue + g.thisMonth + g.future + g.paused + g.archived).first { $0.id == item.id }
        }
        loaded = true
    }

    /// What the app looks for when it links bank transactions to this item.
    private var rulesCard: some View {
        let r = current
        return Card("Matching rules", trailing: AnyView(Button("Edit") { showEdit = true }.font(.subheadline.weight(.medium)))) {
            if let name = r.matchName, !name.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Name contains \u{201C}\(name)\u{201D}", systemImage: "textformat")
                    Label(RecurringEditSheet.rangeText(min: r.matchMinAmount, max: r.matchMaxAmount), systemImage: "dollarsign.circle")
                    if let d = r.matchDayOfMonth { Label("Posts on day \(d) of the month", systemImage: "calendar") }
                }
                .font(.subheadline).foregroundStyle(.secondary)
            } else {
                Text("No rules yet, so new payments won't link automatically. Set a name and an amount range to start matching.")
                    .font(.subheadline).foregroundStyle(.secondary)
                Button("Set up matching") { showEdit = true }.buttonStyle(.borderedProminent).controlSize(.small)
            }
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

private struct PreviewTxn: Decodable, Identifiable {
    let txn: Txn
    let linked: Bool
    var id: String { txn.id }
    private enum K: String, CodingKey { case linked }
    init(from decoder: Decoder) throws {
        txn = try Txn(from: decoder)
        linked = try decoder.container(keyedBy: K.self).decodeIfPresent(Bool.self, forKey: .linked) ?? false
    }
}

/// Fine-tune how an item finds its payments: name text, amount range, day of month, frequency.
/// A live list shows which bank transactions the rules would claim as you type.
struct RecurringEditSheet: View {
    let item: RecurringItem
    let onDone: () async -> Void
    @EnvironmentObject var api: API
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var matchName = ""
    @State private var minText = ""
    @State private var maxText = ""
    @State private var useDay = false
    @State private var day = 1
    @State private var frequency = "monthly"
    @State private var matches: [PreviewTxn] = []
    @State private var searching = false
    @State private var error: String?
    @State private var working = false

    static func rangeText(min: Int?, max: Int?) -> String {
        switch (min, max) {
        case let (lo?, hi?): return "Amount \(Fmt.money(lo)) to \(Fmt.money(hi))"
        case let (lo?, nil): return "Amount \(Fmt.money(lo)) or more"
        case let (nil, hi?): return "Amount up to \(Fmt.money(hi))"
        default: return "Any amount"
        }
    }

    private func cents(_ t: String) -> Int? {
        let c = t.replacingOccurrences(of: "$", with: "").replacingOccurrences(of: ",", with: "").trimmingCharacters(in: .whitespaces)
        guard let v = Double(c), v >= 0 else { return nil }
        return Int((v * 100).rounded())
    }
    private var minC: Int? { cents(minText) }
    private var maxC: Int? { cents(maxText) }
    private var rangeInvalid: Bool { if let a = minC, let b = maxC { return a > b }; return false }
    private var ruleKey: String { "\(matchName)|\(minText)|\(maxText)|\(useDay ? day : 0)" }
    private var canSave: Bool { !matchName.trimmingCharacters(in: .whitespaces).isEmpty && !rangeInvalid && !working }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    Card("Name") {
                        field("Display name", text: $name)
                        Picker("Repeats", selection: $frequency) {
                            ForEach(["weekly", "biweekly", "semimonthly", "monthly", "yearly"], id: \.self) { Text(label($0)).tag($0) }
                        }
                    }
                    Card("Match payments that…") {
                        field("Name contains (e.g. Verizon)", text: $matchName)
                        HStack(spacing: 10) {
                            field("Min $", text: $minText, decimal: true)
                            Text("to").foregroundStyle(.secondary)
                            field("Max $", text: $maxText, decimal: true)
                        }
                        HStack(spacing: 8) {
                            Text("Quick range").font(.footnote).foregroundStyle(.secondary)
                            ForEach([10, 20], id: \.self) { pct in
                                Button("\u{00B1}\(pct)%") { applyTolerance(Double(pct) / 100) }
                                    .buttonStyle(.bordered).controlSize(.small)
                            }
                            Spacer()
                        }
                        if rangeInvalid { Text("Minimum can\u{2019}t be above the maximum.").font(.caption).foregroundStyle(Color.alert) }
                        Toggle("Posts on a specific day", isOn: $useDay.animation())
                        if useDay { Stepper("Day \(day) of the month", value: $day, in: 1...31) }
                        Text("Leave amounts blank to match any amount. Only expenses are matched.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Card("Would match", trailing: AnyView(Group { if searching { ProgressView().controlSize(.small) } else { Text("\(matches.count)").font(.footnote).foregroundStyle(.secondary) } })) {
                        if matches.isEmpty {
                            Text(matchName.trimmingCharacters(in: .whitespaces).isEmpty ? "Enter a name to preview matches." : "No transactions fit these rules.")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(matches.prefix(30)) { m in
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(m.txn.displayName).font(.subheadline.weight(.medium)).lineLimit(1)
                                    Text(Fmt.shortDate(m.txn.date)).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(Fmt.money(abs(m.txn.normalizedAmount))).font(.subheadline.monospacedDigit())
                                Button { Task { await toggle(m) } } label: {
                                    Image(systemName: m.linked ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(m.linked ? Color.income : .secondary)
                                }
                                .buttonStyle(.plain)
                                .help(m.linked ? "Linked. Click to remove." : "Not linked yet. Click to add.")
                            }
                            if m.id != matches.prefix(30).last?.id { Divider() }
                        }
                        if !matches.isEmpty {
                            Text("Saving links every unlinked match. Tap a check to take one out or put it back.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    if let error { Text(error).font(.footnote).foregroundStyle(Color.alert) }
                }
                .padding()
                .frame(maxWidth: 640)
                .frame(maxWidth: .infinity)
            }
            .background(Color.canvas)
            .navigationTitle("Edit recurring")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await save() } }.disabled(!canSave) }
            }
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 620)
        #endif
        .onAppear(perform: seed)
        .task(id: ruleKey) {
            try? await Task.sleep(nanoseconds: 300_000_000)
            if Task.isCancelled { return }
            await preview()
        }
    }

    private func label(_ f: String) -> String {
        switch f {
        case "biweekly": return "Every 2 weeks"
        case "semimonthly": return "Twice a month"
        default: return f.capitalized
        }
    }

    private func field(_ title: String, text: Binding<String>, decimal: Bool = false) -> some View {
        TextField(title, text: text).textFieldStyle(.roundedBorder)
            #if os(iOS)
            .keyboardType(decimal ? .decimalPad : .default)
            #endif
    }

    private func seed() {
        guard name.isEmpty else { return }
        name = item.name
        matchName = item.matchName ?? item.merchantName ?? item.name
        if let v = item.matchMinAmount { minText = String(format: "%.2f", Double(v) / 100) }
        if let v = item.matchMaxAmount { maxText = String(format: "%.2f", Double(v) / 100) }
        if let d = item.matchDayOfMonth { useDay = true; day = d }
        frequency = item.frequency ?? "monthly"
    }

    private func applyTolerance(_ t: Double) {
        let base = Double(item.amount)
        guard base > 0 else { return }
        minText = String(format: "%.2f", base * (1 - t) / 100)
        maxText = String(format: "%.2f", base * (1 + t) / 100)
    }

    private func preview() async {
        let n = matchName.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty, !rangeInvalid else { matches = []; return }
        searching = true
        defer { searching = false }
        var q = ["name": n]
        if let v = minC { q["min"] = String(v) }
        if let v = maxC { q["max"] = String(v) }
        if useDay { q["day"] = String(day) }
        if let rows: [PreviewTxn] = try? await api.get("api/native/recurring/\(item.id)/preview", query: q) {
            matches = rows
        }
    }

    private func toggle(_ m: PreviewTxn) async {
        do {
            if m.linked {
                try await api.delete("api/native/recurring/\(item.id)/link/\(m.txn.id)")
            } else {
                try await api.post("api/native/recurring/\(item.id)/link", body: ["transactionId": m.txn.id])
            }
            await preview()
        } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        working = true
        defer { working = false }
        var body: [String: Any] = [
            "name": name.trimmingCharacters(in: .whitespaces),
            "matchName": matchName.trimmingCharacters(in: .whitespaces),
            "frequency": frequency,
            "matchMinAmount": minC as Any? ?? NSNull(),
            "matchMaxAmount": maxC as Any? ?? NSNull(),
            "matchDayOfMonth": useDay ? day : NSNull(),
        ]
        if (body["name"] as? String)?.isEmpty == true { body["name"] = item.name }
        do {
            try await api.put("api/native/recurring/\(item.id)/rules", body: body)
            await onDone()
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
