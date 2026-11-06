import SwiftUI
import QuickLook

struct AddReceiptMenu: View {
    @EnvironmentObject var actions: AppActions

    var body: some View {
        Menu {
            #if os(iOS)
            if DocumentScanner.isAvailable {
                Button { actions.showScanner = true } label: { Label("Scan receipt", systemImage: "doc.viewfinder") }
            }
            #endif
            Button { actions.showPhotoPicker = true } label: { Label("Choose photo", systemImage: "photo") }
            Button { actions.showImporter = true } label: { Label("Choose file…", systemImage: "folder") }
        } label: {
            Label("Add receipt", systemImage: "plus.viewfinder")
        }
    }
}

struct ReceiptsView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var queue: UploadQueue
    @EnvironmentObject var connection: Connection
    @State private var waiting: [UnmatchedReceipt] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var preview: URL?

    var body: some View {
        List {
            Section {
                HStack(spacing: 12) {
                    #if os(iOS)
                    if DocumentScanner.isAvailable { ActionButton(title: "Scan", symbol: "doc.viewfinder") { actionsScan() } }
                    #endif
                    ActionButton(title: "Photo", symbol: "photo") { actionsPhoto() }
                    ActionButton(title: "File", symbol: "folder") { actionsFile() }
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            } footer: {
                Text("Receipts are optional. They're matched to a transaction automatically when the amount and date line up.")
            }

            if !queue.items.isEmpty {
                Section("Uploading") {
                    ForEach(queue.items) { item in
                        Label(item.filename, systemImage: "arrow.up.circle").lineLimit(1)
                    }
                    .onDelete { offsets in offsets.map { queue.items[$0] }.forEach(queue.remove) }
                }
            }

            Section("Waiting for a transaction\(loaded ? " (\(waiting.count))" : "")") {
                if !loaded && error == nil {
                    ProgressView()
                } else if waiting.isEmpty {
                    Text("Nothing waiting.").foregroundStyle(.secondary)
                }
                ForEach(waiting) { r in card(r) }
            }

            if let error {
                Section { Text(error).font(.footnote).foregroundStyle(.red) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.canvas)
        .navigationTitle("Receipts")
        .quickLookPreview($preview)
        .refreshable { await load() }
        .task(id: connection.active) { await load() }
        .onChange(of: queue.items) { _, _ in Task { try? await Task.sleep(for: .seconds(2)); await load() } }
        .onChange(of: queue.uploading) { _, uploading in if !uploading { Task { await load() } } }
    }

    @EnvironmentObject private var actions: AppActions
    private func actionsScan() { actions.showScanner = true }
    private func actionsPhoto() { actions.showPhotoPicker = true }
    private func actionsFile() { actions.showImporter = true }

    private func card(_ r: UnmatchedReceipt) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { Task { await open(r) } } label: {
                HStack {
                    Image(systemName: r.contentType == "application/pdf" ? "doc.richtext" : "doc.text.image")
                    Text(r.originalFilename).lineLimit(1)
                    Spacer()
                }
            }
            .tint(.primary)
            Text([
                r.hintTotalCents.map { "Total \(Fmt.money($0))" },
                r.hintDate.map(Fmt.shortDate),
                r.hintMerchant,
            ].compactMap { $0 }.joined(separator: " · ").nonEmpty ?? "Couldn't read details from this file")
                .font(.caption).foregroundStyle(.secondary)
            if r.suggestions.isEmpty {
                Text("No likely transaction yet.").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(r.suggestions) { s in
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(s.name).font(.subheadline).lineLimit(1)
                        Text("\(Fmt.money(s.amountCents)) · \(Fmt.shortDate(s.date)) · \(s.reasons.joined(separator: ", "))")
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    Button("Attach") { Task { await attach(r, s) } }
                        .buttonStyle(.bordered).controlSize(.small)
                }
            }
        }
        .padding(.vertical, 4)
        .swipeActions {
            Button(role: .destructive) { Task { await remove(r) } } label: { Label("Delete", systemImage: "trash") }
        }
    }

    private func load() async {
        do {
            waiting = try await api.get("api/native/receipts")
            error = nil
        } catch APIError.unauthorized {
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func attach(_ r: UnmatchedReceipt, _ s: Suggestion) async {
        do { try await api.post("api/native/receipts/attach", body: ["receiptId": r.id, "transactionId": s.transactionId]) }
        catch { self.error = error.localizedDescription }
        await load()
    }

    private func remove(_ r: UnmatchedReceipt) async {
        do { try await api.delete("api/native/receipts/\(r.id)") }
        catch { self.error = error.localizedDescription }
        await load()
    }

    private func open(_ r: UnmatchedReceipt) async {
        let summary = ReceiptSummary(id: r.id, originalFilename: r.originalFilename, contentType: r.contentType, sizeBytes: r.sizeBytes, createdAt: r.createdAt)
        do { preview = try await api.downloadReceipt(summary) }
        catch { self.error = error.localizedDescription }
    }
}

private struct ActionButton: View {
    let title: String
    let symbol: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: symbol).font(.title2)
                Text(title).font(.footnote.weight(.medium))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(Color.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
