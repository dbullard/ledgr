import SwiftUI

/// Fixes what Ledgr read from a receipt: total, date, merchant and every line, saved together.
/// Nothing is written until Save; Cancel throws the edits away.
struct ReceiptEditSheet: View {
    let receiptId: String
    let groups: [CategoryGroup]
    let onSaved: () async -> Void

    @EnvironmentObject var api: API
    @Environment(\.dismiss) private var dismiss

    private struct Row: Identifiable {
        let id = UUID()
        var serverId: String?
        var rawName: String
        var productName: String
        var categoryId: String?
        var quantity: String
        var price: String
    }

    @State private var loaded = false
    @State private var saving = false
    @State private var error: String?
    @State private var total = ""
    @State private var date = ""
    @State private var merchant = ""
    @State private var rows: [Row] = []
    /// What the lines are compared with when the total is left empty: the transaction's amount.
    @State private var fallbackExpected: Int?

    private var spendingCategories: [Category] { groups.alphabetical.flatMap { $0.categories.filter { !$0.isIncome } } }
    private var totalCents: Int? { Self.cents(total) }
    private var itemsCents: Int { rows.reduce(0) { $0 + (Self.cents($1.price) ?? 0) } }
    private var gap: Int? {
        guard !rows.isEmpty, let expected = totalCents ?? fallbackExpected else { return nil }
        return expected - itemsCents
    }

    var body: some View {
        NavigationStack {
            Form {
                if !loaded {
                    Section { if error == nil { ProgressView() } }
                } else {
                    Section("Receipt") {
                        TextField("Total", text: $total, prompt: Text("0.00"))
                            #if os(iOS)
                            .keyboardType(.decimalPad)
                            #endif
                        TextField("Date", text: $date, prompt: Text("YYYY-MM-DD"))
                            .autocorrectionDisabled()
                        TextField("Merchant", text: $merchant)
                    }
                    Section {
                        ForEach($rows) { $row in
                            VStack(alignment: .leading, spacing: 8) {
                                TextField("Printed name", text: $row.rawName)
                                TextField("Product name", text: $row.productName)
                                    .foregroundStyle(.secondary)
                                HStack(spacing: 12) {
                                    TextField("Qty", text: $row.quantity)
                                        .frame(maxWidth: 70)
                                    TextField("Price", text: $row.price)
                                    Picker("Category", selection: $row.categoryId) {
                                        Text("No category").tag(String?.none)
                                        ForEach(spendingCategories) { Text($0.name).tag(String?.some($0.id)) }
                                    }
                                    .labelsHidden()
                                }
                                #if os(iOS)
                                .keyboardType(.decimalPad)
                                #endif
                            }
                            .padding(.vertical, 2)
                        }
                        .onDelete { rows.remove(atOffsets: $0) }
                        Button {
                            rows.append(Row(serverId: nil, rawName: "", productName: "", categoryId: nil, quantity: "1", price: ""))
                        } label: { Label("Add line", systemImage: "plus.circle.fill") }
                    } header: {
                        Text("Lines")
                    } footer: {
                        if !rows.isEmpty { Text(footer) }
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(Color.alert).font(.footnote) }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Edit receipt")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: {
                        if saving { ProgressView().controlSize(.small) } else { Text("Save") }
                    }
                    .disabled(!loaded || saving)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 560)
        #endif
        .task { await load() }
    }

    private var footer: String {
        var s = "Lines add up to \(Fmt.money(itemsCents))"
        if let gap, gap != 0 {
            s += gap > 0 ? "; \(Fmt.money(gap)) less than the total (tax or fees?)" : "; \(Fmt.money(-gap)) more than the total"
        }
        return s + "."
    }

    /// "$1,234.50", "12", "-0.10" → cents; nil when it isn't an amount.
    private static func cents(_ text: String) -> Int? {
        let cleaned = text.filter { "0123456789.-".contains($0) }
        guard !cleaned.isEmpty, let value = Decimal(string: cleaned) else { return nil }
        let rounded = NSDecimalNumber(decimal: value * 100).rounding(accordingToBehavior: nil)
        return rounded.intValue
    }

    private static func input(_ cents: Int) -> String { String(format: "%.2f", Double(cents) / 100) }

    private func load() async {
        do {
            let d: ReceiptEditData = try await api.get("api/native/receipts/\(receiptId)")
            total = d.totalCents.map(Self.input) ?? ""
            date = d.date ?? ""
            merchant = d.merchant ?? ""
            rows = d.items.map {
                Row(serverId: $0.id, rawName: $0.rawName, productName: $0.productName ?? "", categoryId: $0.categoryId,
                    quantity: Fmt.quantity($0.quantityMilli), price: Self.input($0.totalCents))
            }
            fallbackExpected = d.totalCents == nil ? d.gapCents.map { d.itemsTotalCents + $0 } : nil
            error = nil
            loaded = true
        } catch APIError.unauthorized {
        } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        error = nil
        let trimmedTotal = total.trimmingCharacters(in: .whitespaces)
        if !trimmedTotal.isEmpty && totalCents == nil { error = "The total isn't a valid amount"; return }
        var items: [[String: Any]] = []
        for (i, r) in rows.enumerated() {
            guard let price = Self.cents(r.price) else { error = "Line \(i + 1): enter a price"; return }
            guard let qty = Double(r.quantity.trimmingCharacters(in: .whitespaces)), qty > 0 else {
                error = "Line \(i + 1): quantity must be more than zero"; return
            }
            let product = r.productName.trimmingCharacters(in: .whitespaces)
            var item: [String: Any] = [
                "rawName": r.rawName,
                "productName": product.isEmpty ? NSNull() : product,
                "categoryId": r.categoryId.map { $0 as Any } ?? NSNull(),
                "quantityMilli": Int((qty * 1000).rounded()),
                "totalCents": price,
            ]
            if let id = r.serverId { item["id"] = id }
            items.append(item)
        }
        let trimmedDate = date.trimmingCharacters(in: .whitespaces)
        let trimmedMerchant = merchant.trimmingCharacters(in: .whitespaces)
        let body: [String: Any] = [
            "totalCents": trimmedTotal.isEmpty ? NSNull() : (totalCents ?? 0) as Any,
            "date": trimmedDate.isEmpty ? NSNull() : trimmedDate,
            "merchant": trimmedMerchant.isEmpty ? NSNull() : trimmedMerchant,
            "items": items,
        ]
        saving = true
        defer { saving = false }
        do {
            let _: ReceiptEditData = try await api.patch("api/native/receipts/\(receiptId)", body: body)
            await onSaved()
            dismiss()
        } catch APIError.unauthorized {
        } catch { self.error = error.localizedDescription }
    }
}
