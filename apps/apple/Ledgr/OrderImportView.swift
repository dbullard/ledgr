import SwiftUI
import UniformTypeIdentifiers

/// Imports Walmart (.xlsx) or Amazon (Order History .csv) order exports as itemized receipts,
/// matched to the bank charges already in Ledgr. Mirrors the web importers: pick a file,
/// see what would happen, then import. Safe to run again.
struct OrderImportView: View {
    enum Store: String, CaseIterable, Identifiable {
        case walmart, amazon
        var id: String { rawValue }
        var title: String { self == .walmart ? "Walmart" : "Amazon" }
        var hint: String {
            self == .walmart ? "Walmart's orders export (.xlsx)." : "Amazon's Order History.csv from Request My Data."
        }
        var types: [UTType] {
            self == .walmart
                ? [UTType(filenameExtension: "xlsx") ?? .data]
                : [.commaSeparatedText, .plainText]
        }
    }

    @EnvironmentObject var api: API
    @State private var store: Store = .walmart
    @State private var showPicker = false
    @State private var fileData: Data?
    @State private var fileName = ""
    @State private var preview: [(label: String, value: Int)] = []
    @State private var working = false
    @State private var result: String?
    @State private var error: String?

    private var path: String { "api/native/import/orders/\(store.rawValue)" }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Card("Store") {
                    Picker("Store", selection: $store) {
                        ForEach(Store.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: store) { _, _ in reset() }
                    Text(store.hint).font(.footnote).foregroundStyle(.secondary)
                    Button { showPicker = true } label: {
                        Label(fileName.isEmpty ? "Choose file…" : fileName, systemImage: "doc.badge.plus")
                    }
                    .buttonStyle(.bordered)
                }
                if !preview.isEmpty {
                    Card("What will happen") {
                        ForEach(Array(preview.enumerated()), id: \.offset) { _, row in
                            HStack {
                                Text(row.label).font(.subheadline)
                                Spacer()
                                Text("\(row.value)").font(.subheadline.monospacedDigit())
                            }
                        }
                    }
                    Button { Task { await runImport() } } label: {
                        HStack { if working { ProgressView().controlSize(.small) }; Text("Import receipts") }
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .disabled(working || result != nil)
                }
                if let result { Card { Label(result, systemImage: "checkmark.circle.fill").foregroundStyle(Color.income) } }
                if let error { Card { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.alert) } }
            }
            .padding()
        }
        .background(Color.canvas)
        .navigationTitle("Import orders")
        .fileImporter(isPresented: $showPicker, allowedContentTypes: store.types, allowsMultipleSelection: false) { res in
            Task { await picked(res) }
        }
    }

    private func reset() {
        fileData = nil; fileName = ""; preview = []; result = nil; error = nil
    }

    private func picked(_ res: Result<[URL], Error>) async {
        result = nil; error = nil; preview = []
        guard case .success(let urls) = res, let url = urls.first else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { error = "Couldn't read that file."; return }
        fileData = data
        fileName = url.lastPathComponent
        working = true
        defer { working = false }
        do {
            let json = try await api.upload(path + "/preview", fields: [:], file: data, filename: fileName)
            preview = Self.rows(json, store: store)
        } catch APIError.unauthorized {
        } catch { self.error = error.localizedDescription }
    }

    private func runImport() async {
        guard let fileData else { return }
        working = true
        defer { working = false }
        do {
            let json = try await api.upload(path, fields: [:], file: fileData, filename: fileName)
            let n = { (k: String) in (json[k] as? Int) ?? 0 }
            result = "Imported \(n("imported")) receipt\(n("imported") == 1 ? "" : "s") with \(n("items")) items."
                + (n("duplicates") > 0 ? " \(n("duplicates")) already had receipts." : "")
                + (n("failed") > 0 ? " \(n("failed")) failed." : "")
            api.noteChanged()
        } catch APIError.unauthorized {
        } catch { self.error = error.localizedDescription }
    }

    private static func rows(_ j: [String: Any], store: Store) -> [(label: String, value: Int)] {
        func v(_ k: String) -> Int { (j[k] as? Int) ?? 0 }
        if store == .walmart {
            return [("Orders in file", v("ordersInFile")), ("Will import", v("toImport")), ("Already itemized", v("alreadyItemized")),
                    ("Orders with no matching charge", v("unmatchedOrders")), ("Items to add", v("itemsToImport"))]
        }
        return [("Order lines in file", v("orderLines")), ("Will import", v("toImport")), ("Already itemized", v("alreadyItemized")),
                ("Items to add", v("itemsToImport"))]
    }
}
