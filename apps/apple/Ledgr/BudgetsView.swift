import SwiftUI

struct BudgetCategoryModel: Codable, Identifiable, Hashable {
    let budgetCategoryId: String
    let categoryId: String
    let categoryName: String
    let categoryIcon: String?
    let limitAmount: Int
    let spent: Int
    let remaining: Int
    let isFixed: Bool
    var id: String { budgetCategoryId }
}

struct BudgetGroupModel: Codable, Identifiable {
    let groupId: String
    let groupName: String
    let groupIcon: String?
    let categories: [BudgetCategoryModel]
    let totalBudgeted: Int
    let totalSpent: Int
    var id: String { groupId }
}

struct UnbudgetedModel: Codable, Identifiable {
    let categoryId: String
    let categoryName: String
    let groupName: String
    let spent: Int
    var id: String { categoryId }
}

struct BudgetInfo: Codable {
    let id: String
    let month: String
    let type: String
}

struct BudgetSummary: Codable {
    let totalBudgeted: Int
    let totalSpent: Int
    let totalRemaining: Int
}

struct BudgetUnbudgeted: Codable {
    let spent: Int
    let categories: [UnbudgetedModel]
}

struct BudgetResponse: Codable {
    let month: String
    let previousMonth: String
    let hasPreviousBudget: Bool
    let budget: BudgetInfo?
    let groups: [BudgetGroupModel]
    let unbudgeted: BudgetUnbudgeted
    let summary: BudgetSummary
}

private enum MonthMath {
    static func current() -> String {
        let c = Calendar.current.dateComponents([.year, .month], from: Date())
        return String(format: "%04d-%02d", c.year ?? 2000, c.month ?? 1)
    }

    static func shift(_ month: String, _ delta: Int) -> String {
        let p = month.split(separator: "-").compactMap { Int($0) }
        guard p.count == 2 else { return month }
        let idx = p[0] * 12 + (p[1] - 1) + delta
        return String(format: "%04d-%02d", idx / 12, idx % 12 + 1)
    }

    static func title(_ month: String) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM"
        guard let d = f.date(from: month) else { return month }
        f.dateFormat = "MMMM yyyy"
        return f.string(from: d)
    }
}

struct BudgetsView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var connection: Connection
    @State private var month = MonthMath.current()
    @State private var data: BudgetResponse?
    @State private var error: String?
    @State private var editing: EditTarget?
    @State private var busy = false

    struct EditTarget: Identifiable {
        let categoryId: String
        let name: String
        let limit: Int
        let existing: Bool
        var id: String { categoryId }
    }

    var body: some View {
        ScrollView {
            if let data {
                VStack(spacing: 16) {
                    monthBar
                    if data.budget == nil {
                        empty(data)
                    } else {
                        summary(data)
                        ForEach(data.groups) { group in groupCard(group) }
                        unbudgeted(data)
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
        .navigationTitle("Budgets")
        .refreshable { await load() }
        .task(id: "\(connection.active?.absoluteString ?? "")|\(month)") { await load() }
        .sheet(item: $editing) { target in
            LimitEditor(target: target) { cents in
                await save(target, cents)
            } onRemove: {
                await remove(target)
            }
            .presentationDetents([.height(300)])
        }
    }

    private func setType(_ id: String, _ type: String) async {
        do { let _: Ok = try await api.patch("api/native/budgets/\(id)", body: ["type": type]); await load() }
        catch { self.error = error.localizedDescription }
    }

    // MARK: Pieces

    private var monthBar: some View {
        HStack {
            Button { month = MonthMath.shift(month, -1) } label: { Image(systemName: "chevron.left") }
            Spacer()
            Text(MonthMath.title(month)).font(.headline)
            Spacer()
            Button { month = MonthMath.shift(month, 1) } label: { Image(systemName: "chevron.right") }
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 4)
    }

    private func empty(_ d: BudgetResponse) -> some View {
        Card {
            VStack(spacing: 12) {
                Image(systemName: "chart.pie").font(.largeTitle).foregroundStyle(.secondary)
                Text("No budget for \(MonthMath.title(month))").font(.headline)
                if d.hasPreviousBudget {
                    Button("Copy from \(MonthMath.title(d.previousMonth))") { Task { await create(copy: true) } }
                        .buttonStyle(.borderedProminent)
                }
                Button("Start empty") { Task { await create(copy: false) } }
                    .buttonStyle(.bordered)
                if let error { Text(error).font(.caption).foregroundStyle(Color.alert) }
            }
            .frame(maxWidth: .infinity)
            .disabled(busy)
        }
    }

    private func summary(_ d: BudgetResponse) -> some View {
        let s = d.summary
        let over = s.totalRemaining < 0
        return Card {
            VStack(alignment: .leading, spacing: 6) {
                Text(over ? "Over budget" : "Left to spend").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                Text(Fmt.money(abs(s.totalRemaining)))
                    .font(.system(size: 36, weight: .bold)).monospacedDigit()
                    .foregroundStyle(over ? Color.red : Color.primary)
                ProgressBar(fraction: s.totalBudgeted > 0 ? Double(s.totalSpent) / Double(s.totalBudgeted) : 0, over: over)
                HStack {
                    Text("Spent \(Fmt.moneyWhole(s.totalSpent))")
                    Spacer()
                    Text("Budget \(Fmt.moneyWhole(s.totalBudgeted))")
                }
                .font(.footnote).foregroundStyle(.secondary)
                if let b = d.budget {
                    Picker("Budget style", selection: Binding(get: { b.type }, set: { v in Task { await setType(b.id, v) } })) {
                        Text("By category").tag("category")
                        Text("Flexible").tag("flex")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .padding(.top, 6)
                }
            }
        }
    }

    private func groupCard(_ g: BudgetGroupModel) -> some View {
        Card(g.groupName, trailing: AnyView(
            Text("\(Fmt.moneyWhole(g.totalSpent)) of \(Fmt.moneyWhole(g.totalBudgeted))")
                .font(.footnote.monospacedDigit()).foregroundStyle(.secondary))) {
            ForEach(g.categories) { c in
                Button {
                    editing = EditTarget(categoryId: c.categoryId, name: c.categoryName, limit: c.limitAmount, existing: true)
                } label: { categoryRow(c) }
                .buttonStyle(.plain)
                if c.id != g.categories.last?.id { Divider() }
            }
        }
    }

    private func categoryRow(_ c: BudgetCategoryModel) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                CategoryBadge(icon: c.categoryIcon, size: 30)
                Text(c.categoryName).font(.body.weight(.medium))
                Spacer()
                Text(c.remaining >= 0 ? "\(Fmt.moneyWhole(c.remaining)) left" : "\(Fmt.moneyWhole(-c.remaining)) over")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(c.remaining >= 0 ? Color.secondary : Color.red)
            }
            ProgressBar(fraction: c.limitAmount > 0 ? Double(c.spent) / Double(c.limitAmount) : (c.spent > 0 ? 1 : 0), over: c.remaining < 0)
            HStack {
                Text("\(Fmt.moneyWhole(c.spent)) spent")
                Spacer()
                Text("of \(Fmt.moneyWhole(c.limitAmount))")
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
    }

    private func unbudgeted(_ d: BudgetResponse) -> some View {
        Group {
            if !d.unbudgeted.categories.isEmpty {
                Card("Not in budget", trailing: AnyView(
                    Text(Fmt.moneyWhole(d.unbudgeted.spent)).font(.footnote.monospacedDigit()).foregroundStyle(.secondary))) {
                    ForEach(d.unbudgeted.categories) { c in
                        Button {
                            if c.categoryId != "uncategorized" {
                                editing = EditTarget(categoryId: c.categoryId, name: c.categoryName, limit: c.spent, existing: false)
                            }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(c.categoryName).font(.body)
                                    Text(c.groupName).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(Fmt.money(c.spent)).font(.body.monospacedDigit())
                                if c.categoryId != "uncategorized" {
                                    Image(systemName: "plus.circle").foregroundStyle(Color.accentColor)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        if c.id != d.unbudgeted.categories.last?.id { Divider() }
                    }
                }
            }
        }
    }

    // MARK: Data

    private func load() async {
        do {
            data = try await api.get("api/native/budgets", query: ["month": month])
            error = nil
        } catch APIError.unauthorized {
        } catch {
            if data == nil { self.error = error.localizedDescription }
        }
    }

    private func create(copy: Bool) async {
        busy = true
        defer { busy = false }
        do {
            try await api.post("api/native/budgets", body: ["month": month, "copyFromPrevious": copy])
            error = nil
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func save(_ t: EditTarget, _ cents: Int) async {
        guard let id = data?.budget?.id else { return }
        do {
            let _: Ok = try await api.patch("api/native/budgets/\(id)/categories/\(t.categoryId)", body: ["limit": cents])
            editing = nil
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func remove(_ t: EditTarget) async {
        guard let id = data?.budget?.id else { return }
        do {
            try await api.delete("api/native/budgets/\(id)/categories/\(t.categoryId)")
            editing = nil
            await load()
        } catch { self.error = error.localizedDescription }
    }
}

struct Ok: Codable { let success: Bool? }

struct ProgressBar: View {
    let fraction: Double
    var over = false

    var body: some View {
        GeometryReader { geo in
            Capsule().fill(Color.track)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(over ? Color.red : (fraction > 0.85 ? Color.alert : Color.accentColor))
                        .frame(width: max(0, min(1, fraction)) * geo.size.width)
                }
        }
        .frame(height: 8)
    }
}

struct LimitEditor: View {
    let target: BudgetsView.EditTarget
    let onSave: (Int) async -> Void
    let onRemove: () async -> Void
    @State private var text = ""
    @State private var working = false
    @Environment(\.dismiss) private var dismiss

    private var cents: Int? {
        let cleaned = text.replacingOccurrences(of: "$", with: "").replacingOccurrences(of: ",", with: "").trimmingCharacters(in: .whitespaces)
        guard let v = Double(cleaned), v >= 0 else { return nil }
        return Int((v * 100).rounded())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(target.name).font(.title3.weight(.semibold))
            Text("Monthly limit").font(.subheadline).foregroundStyle(.secondary)
            TextField("0.00", text: $text)
                .textFieldStyle(.roundedBorder)
                #if os(iOS)
                .keyboardType(.decimalPad)
                #endif
            HStack {
                if target.existing {
                    Button("Remove", role: .destructive) { Task { working = true; await onRemove(); working = false } }
                }
                Spacer()
                Button("Cancel") { dismiss() }
                Button(target.existing ? "Save" : "Add to budget") {
                    guard let cents else { return }
                    Task { working = true; await onSave(cents); working = false }
                }
                .buttonStyle(.borderedProminent)
                .disabled(cents == nil || working)
            }
        }
        .padding(20)
        .onAppear { text = String(format: "%.2f", Double(target.limit) / 100) }
    }
}
