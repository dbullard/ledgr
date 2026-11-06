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

struct RecurringView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var connection: Connection
    @State private var data: RecurringResponse?
    @State private var error: String?
    @State private var search = ""
    @State private var showCreate = false

    var body: some View {
        ScrollView {
            if let data {
                VStack(spacing: 16) {
                    header(data.summary)
                    section("Overdue", data.groups.overdue, tint: .red)
                    section("Due this month", data.groups.thisMonth)
                    section("Later", data.groups.future)
                    section("Paused", data.groups.paused)
                    section("Archived", data.groups.archived)
                    if allItems(data).isEmpty {
                        Card { Text(search.isEmpty ? "No recurring items yet." : "Nothing matches.").foregroundStyle(.secondary) }
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
                Button { showCreate = true } label: { Image(systemName: "plus") }
            }
        }
        .refreshable { await load() }
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

    private func section(_ title: String, _ items: [RecurringItem], tint: Color? = nil) -> some View {
        let rows = filtered(items)
        return Group {
            if !rows.isEmpty {
                Card(title, trailing: AnyView(Text("\(rows.count)").font(.footnote).foregroundStyle(.secondary))) {
                    ForEach(rows) { item in
                        NavigationLink(value: item) { RecurringRow(item: item, tint: tint) }.buttonStyle(.plain)
                        if item.id != rows.last?.id { Divider() }
                    }
                }
            }
        }
    }

    private func load() async {
        do {
            data = try await api.get("api/native/recurring")
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

    var body: some View {
        HStack(spacing: 12) {
            CategoryBadge(icon: item.categoryIcon ?? "repeat")
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).font(.body.weight(.medium)).lineLimit(1)
                HStack(spacing: 4) {
                    if let label = item.relativeDateLabel { Text(label).foregroundStyle(tint ?? .secondary) }
                    if !item.frequencyLabel.isEmpty { Text("· \(item.frequencyLabel)") }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Text(Fmt.money(item.amount)).font(.body.monospacedDigit().weight(.medium))
        }
        .contentShape(Rectangle())
    }
}

struct RecurringDetailView: View {
    let item: RecurringItem
    @EnvironmentObject var api: API
    @Environment(\.dismiss) private var dismiss
    @State private var txns: [Txn] = []
    @State private var loaded = false
    @State private var note: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Card {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(item.frequencyLabel).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                        Text(Fmt.money(item.amount)).font(.system(size: 36, weight: .bold)).monospacedDigit()
                        if let next = item.nextDate {
                            Label("Next \(Fmt.shortDate(next))" + (item.relativeDateLabel.map { " · \($0)" } ?? ""), systemImage: "calendar")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        if let cat = item.categoryName { Label(cat, systemImage: "tag").font(.footnote).foregroundStyle(.secondary) }
                        if let acct = item.accountName { Label(acct, systemImage: "building.columns").font(.footnote).foregroundStyle(.secondary) }
                    }
                    HStack {
                        if item.lifecycle == "active" {
                            Button("Pause") { Task { await set("paused") } }
                            Button("Archive", role: .destructive) { Task { await set("archived") } }
                        } else {
                            Button("Resume") { Task { await set("active") } }.buttonStyle(.borderedProminent)
                            if item.lifecycle == "paused" { Button("Archive", role: .destructive) { Task { await set("archived") } } }
                        }
                    }
                    .buttonStyle(.bordered)
                    if let note { Text(note).font(.caption).foregroundStyle(Color.alert) }
                }
                Card("Payment history") {
                    if txns.isEmpty { Text(loaded ? "No linked transactions" : "Loading…").foregroundStyle(.secondary) }
                    ForEach(txns) { txn in
                        NavigationLink(value: txn) { TxnRow(txn: txn) }.buttonStyle(.plain)
                        if txn.id != txns.last?.id { Divider() }
                    }
                }
            }
            .padding()
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
