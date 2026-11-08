import SwiftUI

/// One category's proposed monthly limit, worked out from the last year of spending.
struct BudgetSuggestion: Identifiable {
    let categoryId: String
    let name: String
    let current: Int?      // existing limit, cents
    let suggested: Int     // cents
    let typical: Int       // average month, cents
    var id: String { categoryId }
    var delta: Int { suggested - (current ?? 0) }
}

/// A budgeted category that is over, or on pace to go over, this month.
struct BudgetAttention: Identifiable {
    let categoryId: String
    let name: String
    let spent: Int
    let limit: Int
    let projected: Int?    // month-end at the current pace, nil when too early to tell
    let isOver: Bool
    var id: String { categoryId }
}

enum BudgetPlanner {
    static func monthTitle(_ month: String) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM"
        guard let d = f.date(from: month) else { return month }
        f.dateFormat = "LLLL yyyy"
        return f.string(from: d)
    }

    /// How much of the month has passed: 0 for a future month, 1 for a past one.
    static func elapsed(_ month: String, now: Date = Date()) -> Double {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM"
        let current = f.string(from: now)
        if month < current { return 1 }
        if month > current { return 0 }
        let cal = Calendar.current
        let days = cal.range(of: .day, in: .month, for: now)?.count ?? 30
        return Double(cal.component(.day, from: now)) / Double(days)
    }

    /// Categories over their limit, or heading there at this month's pace (fixed bills never project).
    static func attention(_ d: BudgetResponse, month: String) -> [BudgetAttention] {
        let e = elapsed(month)
        let items: [BudgetAttention] = d.groups.flatMap(\.categories).compactMap { c in
            guard c.limitAmount > 0 else { return nil }
            let over = c.spent > c.limitAmount
            let projected = (!c.isFixed && e >= 0.2 && e < 1) ? Int(Double(c.spent) / e) : nil
            let heading = projected.map { $0 > Int(Double(c.limitAmount) * 1.1) } ?? false
            guard over || heading else { return nil }
            return BudgetAttention(categoryId: c.categoryId, name: c.categoryName, spent: c.spent,
                                   limit: c.limitAmount, projected: projected, isOver: over)
        }
        return items.sorted { ($0.projected ?? $0.spent) - $0.limit > ($1.projected ?? $1.spent) - $1.limit }
    }

    /// "Typical month plus a little room": the average of the mean and median month over up to
    /// the 12 months before `month`, rounded up. Fixed bills use their latest amount instead.
    static func suggestions(trends: [TrendRow], data: BudgetResponse, month: String) -> [BudgetSuggestion] {
        let periods = Array(Set(trends.map(\.period)).filter { $0 < month }.sorted().suffix(12))
        guard periods.count >= 2 else { return [] }
        let existing = Dictionary(uniqueKeysWithValues: data.groups.flatMap(\.categories).map { ($0.categoryId, $0) })
        var byCat: [String: (name: String, months: [String: Int])] = [:]
        for r in trends {
            guard let id = r.categoryId, periods.contains(r.period) else { continue }
            var e = byCat[id] ?? (r.categoryName, [:])
            e.months[r.period, default: 0] += r.total
            byCat[id] = e
        }
        return byCat.compactMap { id, e in
            let values = periods.map { e.months[$0] ?? 0 }
            let active = values.filter { $0 > 0 }.count
            let cur = existing[id]
            guard active >= 2 || cur != nil else { return nil }   // skip one-off spending
            let mean = Double(values.reduce(0, +)) / Double(values.count)
            let sorted = values.sorted()
            let median = Double(sorted[sorted.count / 2])
            var base = (mean + median) / 2
            if cur?.isFixed == true, let last = values.last(where: { $0 > 0 }) { base = Double(last) }
            let s = roundUp(base * 1.05)
            guard s >= 500 || cur != nil else { return nil }
            return BudgetSuggestion(categoryId: id, name: e.name, current: cur?.limitAmount, suggested: s, typical: Int(mean))
        }.sorted { $0.suggested > $1.suggested }
    }

    private static func roundUp(_ cents: Double) -> Int {
        let step: Double = cents < 5_000 ? 500 : (cents < 50_000 ? 1_000 : 2_500)
        return Int((cents / step).rounded(.up) * step)
    }

    static func loadTrends(_ api: API) async -> [TrendRow]? {
        let r: TrendsReport? = try? await api.get("api/native/reports/trends", query: ["range": "1Y"])
        return r?.rows
    }
}

/// Budget insights: where this month stands, what's at risk, and a suggested budget from the
/// last year of spending. The numbers are calculated; the on-device model only words the summary.
struct BudgetInsightsCard: View {
    let data: BudgetResponse
    let month: String
    let reload: () async -> Void

    @EnvironmentObject var api: API
    @State private var plan: [BudgetSuggestion]?
    @State private var planning = false
    @State private var planFailed = false
    @State private var applying = false
    @State private var confirm = false
    @State private var showAll = false
    @State private var summary: String?
    @State private var summarizing = false
    @State private var note: String?

    private var cats: [BudgetCategoryModel] { data.groups.flatMap(\.categories) }
    private var attention: [BudgetAttention] { BudgetPlanner.attention(data, month: month) }
    private var over: Int { cats.filter { $0.spent > $0.limitAmount && $0.limitAmount > 0 }.count }
    private var near: Int { cats.filter { $0.limitAmount > 0 && $0.spent <= $0.limitAmount && Double($0.spent) >= 0.85 * Double($0.limitAmount) }.count }
    private var onTrack: Int { max(0, cats.count - over - near) }
    private var changes: [BudgetSuggestion] { (plan ?? []).filter { $0.delta != 0 } }

    var body: some View {
        Card("Insights", trailing: AnyView(Image(systemName: "sparkles").foregroundStyle(Color.accentColor))) {
            HStack(spacing: 10) {
                stat("\(onTrack)", "On track", .income)
                stat("\(near)", "Near limit", .alert)
                stat("\(over)", "Over", .red)
            }
            if let line = paceLine { Text(line).font(.subheadline).foregroundStyle(.secondary) }
            if !attention.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("NEEDS ATTENTION").font(.caption2.weight(.semibold)).tracking(0.6).foregroundStyle(.secondary)
                    ForEach(attention.prefix(4)) { a in attentionRow(a) }
                }
            }
            if OnDeviceAI.isAvailable { summaryBlock }
            Divider()
            planSection
        }
        .confirmationDialog("Update \(changes.count) limits for \(BudgetPlanner.monthTitle(month))?",
                            isPresented: $confirm, titleVisibility: .visible) {
            Button("Apply suggested budget") { Task { await apply() } }
        } message: { Text("This replaces your current limits for the categories listed.") }
        .onChange(of: month) { _, _ in plan = nil; summary = nil; note = nil }
    }

    // MARK: Pieces

    private func stat(_ n: String, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 2) {
            Text(n).font(.title2.weight(.bold)).monospacedDigit().foregroundStyle(color)
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var paceLine: String? {
        let e = BudgetPlanner.elapsed(month)
        guard e >= 0.2, e < 1, data.summary.totalBudgeted > 0 else { return nil }
        let projected = Int(Double(data.summary.totalSpent) / e)
        let diff = projected - data.summary.totalBudgeted
        return diff > 0
            ? "At this pace you'll spend about \(Fmt.moneyWhole(projected)), \(Fmt.moneyWhole(diff)) over budget."
            : "At this pace you'll spend about \(Fmt.moneyWhole(projected)), \(Fmt.moneyWhole(-diff)) under budget."
    }

    private func attentionRow(_ a: BudgetAttention) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(a.name).font(.subheadline.weight(.medium))
                Spacer()
                if a.isOver {
                    Text("Over by \(Fmt.moneyWhole(a.spent - a.limit))").font(.caption.weight(.semibold)).foregroundStyle(Color.red)
                } else if let p = a.projected {
                    Text("On pace for \(Fmt.moneyWhole(p))").font(.caption.weight(.semibold)).foregroundStyle(Color.alert)
                }
            }
            ProgressBar(fraction: Double(a.spent) / Double(a.limit), over: a.isOver)
            Text("\(Fmt.moneyWhole(a.spent)) of \(Fmt.moneyWhole(a.limit))").font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var summaryBlock: some View {
        if let summary {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "sparkles").foregroundStyle(Color.accentColor)
                Text(summary).font(.subheadline).fixedSize(horizontal: false, vertical: true)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        } else {
            Button {
                summarizing = true
                Task { summary = await OnDeviceAI.budgetHeadline(facts: facts); summarizing = false }
            } label: {
                HStack(spacing: 6) {
                    if summarizing { ProgressView().controlSize(.small) } else { Image(systemName: "sparkles") }
                    Text("Explain this month")
                }
            }
            .disabled(summarizing)
        }
    }

    private var facts: String {
        var t = "\(BudgetPlanner.monthTitle(month)): budget \(Fmt.moneyWhole(data.summary.totalBudgeted)), spent \(Fmt.moneyWhole(data.summary.totalSpent)). "
        t += "\(onTrack) categories on track, \(near) near their limit, \(over) over. "
        if let line = paceLine { t += line + " " }
        for a in attention.prefix(4) {
            t += "\(a.name): spent \(Fmt.moneyWhole(a.spent)) of \(Fmt.moneyWhole(a.limit))" + (a.projected.map { ", on pace for \(Fmt.moneyWhole($0))" } ?? "") + ". "
        }
        if data.unbudgeted.spent > 0 { t += "Spending outside the budget: \(Fmt.moneyWhole(data.unbudgeted.spent))." }
        return t
    }

    // MARK: Suggested budget

    @ViewBuilder private var planSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("SUGGESTED BUDGET").font(.caption2.weight(.semibold)).tracking(0.6).foregroundStyle(.secondary)
            if let plan {
                if plan.isEmpty {
                    Text("Not enough history yet. Needs at least two earlier months of spending.")
                        .font(.subheadline).foregroundStyle(.secondary)
                } else {
                    let total = plan.reduce(0) { $0 + $1.suggested }
                    Text("Based on your typical month over the last year, plus a little room: **\(Fmt.moneyWhole(total))** a month, versus **\(Fmt.moneyWhole(data.summary.totalBudgeted))** now.")
                        .font(.subheadline)
                    ForEach(showAll ? plan : Array(plan.prefix(6))) { s in suggestionRow(s) }
                    if plan.count > 6 {
                        Button(showAll ? "Show fewer" : "Show all \(plan.count)") { withAnimation { showAll.toggle() } }
                            .font(.subheadline)
                    }
                    Button { confirm = true } label: {
                        HStack {
                            if applying { ProgressView().controlSize(.small) }
                            Text(changes.isEmpty ? "Already matches" : "Apply to \(BudgetPlanner.monthTitle(month))")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(applying || changes.isEmpty)
                }
            } else {
                Text("See what each category would be if it matched your spending over the past year.")
                    .font(.subheadline).foregroundStyle(.secondary)
                Button {
                    Task { await loadPlan() }
                } label: {
                    HStack(spacing: 6) {
                        if planning { ProgressView().controlSize(.small) }
                        Text("Suggest a budget")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(planning)
                if planFailed { Text("Couldn't load your spending history.").font(.caption).foregroundStyle(Color.alert) }
            }
            if let note { Text(note).font(.caption).foregroundStyle(.secondary) }
        }
    }

    private func suggestionRow(_ s: BudgetSuggestion) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(s.name).font(.subheadline.weight(.medium))
                Text("Typical \(Fmt.moneyWhole(s.typical))/mo").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if let cur = s.current, cur != s.suggested {
                Text(Fmt.moneyWhole(cur)).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary).strikethrough()
                Image(systemName: "arrow.right").font(.caption2).foregroundStyle(.secondary)
            }
            Text(Fmt.moneyWhole(s.suggested)).font(.subheadline.weight(.semibold).monospacedDigit())
            if s.current == nil { Text("NEW").font(.caption2.weight(.bold)).foregroundStyle(Color.accentColor) }
        }
    }

    private func loadPlan() async {
        planning = true; planFailed = false; note = nil
        defer { planning = false }
        guard let rows = await BudgetPlanner.loadTrends(api) else { planFailed = true; return }
        plan = BudgetPlanner.suggestions(trends: rows, data: data, month: month)
    }

    private func apply() async {
        guard let id = data.budget?.id else { return }
        applying = true
        defer { applying = false }
        var done = 0
        for s in changes {
            if (try? await api.patch("api/native/budgets/\(id)/categories/\(s.categoryId)", body: ["limit": s.suggested]) as Ok) != nil { done += 1 }
        }
        note = done == changes.count ? "Updated \(done) limits." : "Updated \(done) of \(changes.count) limits. Try again for the rest."
        plan = nil
        await reload()
    }
}

extension BudgetPlanner {
    /// For a month with no budget: create it and fill every limit from the last year of spending.
    @MainActor static func buildFromHistory(_ api: API, month: String) async -> Bool {
        guard (try? await api.post("api/native/budgets", body: ["month": month, "copyFromPrevious": false])) != nil,
              let fresh: BudgetResponse = try? await api.get("api/native/budgets", query: ["month": month]),
              let id = fresh.budget?.id,
              let rows = await loadTrends(api) else { return false }
        for s in suggestions(trends: rows, data: fresh, month: month) {
            _ = try? await api.patch("api/native/budgets/\(id)/categories/\(s.categoryId)", body: ["limit": s.suggested]) as Ok
        }
        return true
    }
}
