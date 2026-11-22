import SwiftUI

/// The filters beyond the quick ones (All, Needs review...): a date range, an amount range and one
/// category. They match the web transaction filters and combine with search, account and the quick filter.
struct AdvancedFilters: Equatable, Hashable {
    var dateFrom: Date?
    var dateTo: Date?
    /// Dollars as typed; sent to the server in cents.
    var amountMin = ""
    var amountMax = ""
    var categoryId: String?
    var categoryName: String?

    private static func cents(_ text: String) -> Int? {
        let cleaned = text.replacingOccurrences(of: ",", with: "").replacingOccurrences(of: "$", with: "").trimmingCharacters(in: .whitespaces)
        guard let v = Double(cleaned), v >= 0 else { return nil }
        return Int((v * 100).rounded())
    }

    var isActive: Bool {
        dateFrom != nil || dateTo != nil || Self.cents(amountMin) != nil || Self.cents(amountMax) != nil || categoryId != nil
    }

    /// A short summary for the active-filter chip.
    var summary: String {
        var parts: [String] = []
        if dateFrom != nil || dateTo != nil {
            parts.append([dateFrom.map { Fmt.shortDate(Fmt.iso($0)) } ?? "…", dateTo.map { Fmt.shortDate(Fmt.iso($0)) } ?? "…"].joined(separator: " – "))
        }
        if Self.cents(amountMin) != nil || Self.cents(amountMax) != nil {
            parts.append("$\(amountMin.isEmpty ? "0" : amountMin)–\(amountMax.isEmpty ? "∞" : "$" + amountMax)")
        }
        if let categoryName { parts.append(categoryName) }
        return parts.joined(separator: " · ")
    }

    func apply(to q: inout [String: String]) {
        if let dateFrom { q["dateFrom"] = Fmt.iso(dateFrom) }
        if let dateTo { q["dateTo"] = Fmt.iso(dateTo) }
        if let c = Self.cents(amountMin) { q["amountMin"] = String(c) }
        if let c = Self.cents(amountMax) { q["amountMax"] = String(c) }
        if let categoryId { q["categoryId"] = categoryId }
    }
}

struct TransactionFilterSheet: View {
    @Binding var filters: AdvancedFilters
    let groups: [CategoryGroup]
    @Environment(\.dismiss) private var dismiss
    @State private var pickingCategory = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Date") {
                    optionalDate("From", $filters.dateFrom)
                    optionalDate("To", $filters.dateTo)
                }
                Section("Amount") {
                    HStack {
                        TextField("Min $", text: $filters.amountMin)
                        Text("to").foregroundStyle(.secondary)
                        TextField("Max $", text: $filters.amountMax)
                    }
                    #if os(iOS)
                    .keyboardType(.decimalPad)
                    #endif
                }
                Section("Category") {
                    Button { pickingCategory = true } label: {
                        HStack {
                            Text(filters.categoryName ?? "Any category").foregroundStyle(filters.categoryId == nil ? Color.secondary : Color.primary)
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                    .popover(isPresented: $pickingCategory) {
                        CategoryPicker(groups: groups, currentId: filters.categoryId) { id in
                            filters.categoryId = id
                            filters.categoryName = id.flatMap { cid in groups.flatMap(\.categories).first { $0.id == cid }?.name }
                            pickingCategory = false
                        }
                        .frame(minWidth: 280, minHeight: 320)
                    }
                }
                if filters.isActive {
                    Section { Button("Clear filters", role: .destructive) { filters = AdvancedFilters() } }
                }
            }
            .navigationTitle("Filters")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        #if os(macOS)
        .frame(minWidth: 380, minHeight: 360)
        #endif
    }

    /// A date that can be switched off: a toggle that reveals the picker.
    private func optionalDate(_ label: String, _ binding: Binding<Date?>) -> some View {
        HStack {
            Toggle(label, isOn: Binding(get: { binding.wrappedValue != nil }, set: { on in binding.wrappedValue = on ? (binding.wrappedValue ?? Date()) : nil }))
            if binding.wrappedValue != nil {
                DatePicker("", selection: Binding(get: { binding.wrappedValue ?? Date() }, set: { binding.wrappedValue = $0 }), displayedComponents: .date)
                    .labelsHidden()
            }
        }
    }
}
