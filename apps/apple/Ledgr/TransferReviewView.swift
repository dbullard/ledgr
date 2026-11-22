import SwiftUI

/// Goes through the pairs Ledgr thinks are transfers between your own accounts, one at a time,
/// like the web transfer review. "Transfer" keeps them out of spending and income; "Spending"
/// keeps them as real money and stops Ledgr suggesting them again.
struct TransferReviewView: View {
    let suggestions: [Txn]
    /// Called after the sheet closes, so the list can reload.
    let onDone: () async -> Void

    @EnvironmentObject var api: API
    @Environment(\.dismiss) private var dismiss
    @State private var index = 0
    @State private var resolved = 0
    @State private var working = false
    @State private var error: String?

    private var current: Txn? { index < suggestions.count ? suggestions[index] : nil }

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                if let txn = current {
                    Text("\(index + 1) of \(suggestions.count)").font(.footnote).foregroundStyle(.secondary)
                    Card {
                        VStack(spacing: 10) {
                            MerchantAvatar(txn: txn, size: 56)
                            Text(txn.displayName).font(.headline).multilineTextAlignment(.center)
                            Text(Fmt.money(txn.normalizedAmount))
                                .font(.system(size: 38, weight: .bold, design: .rounded)).monospacedDigit()
                                .foregroundStyle(txn.normalizedAmount > 0 ? Color.income : Color.primary)
                            Text("\(Fmt.dayHeader(txn.date)) · \(txn.accountName)").font(.footnote).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    Text("Is this money moving between your own accounts?").font(.subheadline).foregroundStyle(.secondary)
                    HStack(spacing: 12) {
                        Button { Task { await decide("spending") } } label: { Text("It's spending").frame(maxWidth: .infinity) }
                            .buttonStyle(.bordered)
                        Button { Task { await decide("transfer") } } label: { Text("It's a transfer").frame(maxWidth: .infinity) }
                            .buttonStyle(.borderedProminent)
                    }
                    .controlSize(.large)
                    .disabled(working)
                    Button("Skip") { index += 1 }.buttonStyle(.plain).foregroundStyle(.secondary)
                    if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                } else {
                    ContentUnavailableView("All done", systemImage: "checkmark.circle", description: Text(resolved == 0 ? "Nothing was changed." : "You settled \(resolved) suggestion\(resolved == 1 ? "" : "s")."))
                    Button("Close") { dismiss() }.buttonStyle(.borderedProminent)
                }
                Spacer(minLength: 0)
            }
            .padding(20)
            .background(Color.canvas)
            .navigationTitle("Review transfers")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 440)
        #endif
        .onDisappear { Task { await onDone() } }
    }

    private func decide(_ decision: String) async {
        guard let txn = current else { return }
        working = true
        defer { working = false }
        do {
            try await api.post("api/native/transactions/\(txn.id)/transfer-decision", body: ["decision": decision])
            resolved += 1
            index += 1
            error = nil
        } catch APIError.unauthorized {
        } catch { self.error = error.localizedDescription }
    }
}
