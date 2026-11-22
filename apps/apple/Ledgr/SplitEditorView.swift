import SwiftUI

/// Splits one transaction across categories. Mirrors the web panel's split editor:
/// each line has a category, an amount and an optional note, and "Remaining" shows what
/// is still unassigned. Nothing is saved until Save, then the changes go out together.
struct SplitEditorView: View {
    let txn: Txn
    let groups: [CategoryGroup]
    let existing: [SplitRow]
    /// Called after a successful save so the detail screen can reload.
    let onSaved: () async -> Void

    @EnvironmentObject var api: API
    @Environment(\.dismiss) private var dismiss

    private struct Line: Identifiable, Equatable {
        let id = UUID()
        var splitId: String?
        var categoryId: String?
        var categoryName: String?
        var amountText: String
        var notes: String
    }

    @State private var lines: [Line] = []
    @State private var removed: [String] = []
    @State private var picking: UUID?
    @State private var saving = false
    @State private var error: String?

    private var total: Int { abs(txn.normalizedAmount) }

    private func cents(_ text: String) -> Int? {
        let cleaned = text.replacingOccurrences(of: ",", with: "").replacingOccurrences(of: "$", with: "").trimmingCharacters(in: .whitespaces)
        guard let value = Double(cleaned), value > 0 else { return nil }
        return Int((value * 100).rounded())
    }

    private var assigned: Int { lines.reduce(0) { $0 + (cents($1.amountText) ?? 0) } }
    private var remaining: Int { total - assigned }
    private var complete: Bool { !lines.isEmpty && lines.allSatisfy { $0.categoryId != nil && cents($0.amountText) != nil } }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach($lines) { $line in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Button { picking = line.id } label: {
                                    HStack(spacing: 6) {
                                        Text(line.categoryName ?? "Choose category")
                                            .foregroundStyle(line.categoryId == nil ? Color.accentColor : Color.primary)
                                        Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                                .buttonStyle(.plain)
                                Spacer()
                                TextField("Amount", text: $line.amountText)
                                    .multilineTextAlignment(.trailing)
                                    #if os(iOS)
                                    .keyboardType(.decimalPad)
                                    #endif
                                    .frame(maxWidth: 110)
                                Button(role: .destructive) { remove(line) } label: { Image(systemName: "minus.circle") }
                                    .buttonStyle(.plain).foregroundStyle(.secondary)
                                    .accessibilityLabel("Remove split")
                            }
                            TextField("Note (optional)", text: $line.notes).font(.footnote)
                        }
                        .popover(isPresented: Binding(get: { picking == line.id }, set: { if !$0 { picking = nil } })) {
                            CategoryPicker(groups: groups, incomeOnly: txn.normalizedAmount > 0, currentId: line.categoryId) { id in
                                line.categoryId = id
                                line.categoryName = id.flatMap { cid in groups.flatMap(\.categories).first { $0.id == cid }?.name }
                                picking = nil
                            }
                            .frame(minWidth: 280, minHeight: 320)
                        }
                    }
                    Button { addLine() } label: { Label("Add split", systemImage: "plus") }
                } footer: {
                    Text("Remaining \(Fmt.money(remaining)) of \(Fmt.money(total))")
                        .foregroundStyle(remaining == 0 ? Color.income : Color.alert)
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle("Split transaction")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }.disabled(!complete || saving || remaining < 0)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 360)
        #endif
        .onAppear {
            if lines.isEmpty {
                lines = existing.map {
                    Line(splitId: $0.id, categoryId: $0.categoryId, categoryName: $0.categoryName,
                         amountText: String(format: "%.2f", Double($0.amount) / 100), notes: $0.notes ?? "")
                }
                if lines.isEmpty { addLine() }
            }
        }
    }

    private func addLine() {
        let left = max(remaining, 0)
        lines.append(Line(splitId: nil, categoryId: nil, categoryName: nil,
                          amountText: left > 0 ? String(format: "%.2f", Double(left) / 100) : "", notes: ""))
    }

    private func remove(_ line: Line) {
        if let id = line.splitId { removed.append(id) }
        lines.removeAll { $0.id == line.id }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            // Deletions first so edited lines never briefly overshoot the total.
            for id in removed { try await api.delete("api/native/transactions/\(txn.id)/splits/\(id)") }
            for line in lines {
                guard let cat = line.categoryId, let amount = cents(line.amountText) else { continue }
                let body: [String: Any] = ["categoryId": cat, "amount": amount, "notes": line.notes]
                if let id = line.splitId {
                    try await api.put("api/native/transactions/\(txn.id)/splits/\(id)", body: body)
                } else {
                    try await api.post("api/native/transactions/\(txn.id)/splits", body: body)
                }
            }
            await onSaved()
            dismiss()
        } catch APIError.unauthorized {
        } catch {
            self.error = error.localizedDescription
        }
    }
}
