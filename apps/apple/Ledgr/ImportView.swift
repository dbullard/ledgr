import SwiftUI
import UniformTypeIdentifiers

struct ImportAccount: Codable, Identifiable, Hashable {
    let id: String
    let name: String
}

struct ImportView: View {
    @EnvironmentObject var api: API
    @State private var accounts: [ImportAccount] = []
    @State private var accountId = ""
    @State private var showPicker = false
    @State private var fileData: Data?
    @State private var fileName = ""
    @State private var kind = ""              // "csv" or "ofx"
    @State private var headers: [String] = []
    @State private var sampleRows: [[String: String]] = []
    @State private var totalRows = 0
    @State private var mapping: [String: String] = [:]   // field -> header
    @State private var convention = "positive_is_expense"
    @State private var working = false
    @State private var error: String?
    @State private var result: String?
    @State private var duplicateInfo: (dupes: Int, unique: Int)?

    private let fields: [(key: String, label: String, required: Bool)] = [
        ("date", "Date", true), ("description", "Description", true), ("amount", "Amount", false),
        ("debit", "Debit", false), ("credit", "Credit", false),
    ]

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Card("1 · Pick a file") {
                    Text("CSV, OFX or QFX exported from your bank. Up to 10 MB.").font(.footnote).foregroundStyle(.secondary)
                    Button { showPicker = true } label: {
                        Label(fileName.isEmpty ? "Choose file…" : fileName, systemImage: "doc.badge.plus")
                    }
                    .buttonStyle(.bordered)
                }
                if fileData != nil {
                    Card("2 · Account") {
                        Picker("Import into", selection: $accountId) {
                            Text("Choose…").tag("")
                            ForEach(accounts) { Text($0.name).tag($0.id) }
                        }
                    }
                    if kind == "csv" { mappingCard }
                    previewCard
                    if let duplicateInfo { duplicateCard(duplicateInfo) }
                    Button { Task { await runImport(skipDuplicates: false) } } label: {
                        HStack { if working { ProgressView().controlSize(.small) }; Text("Import \(totalRows) transactions") }
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(!canImport || working)
                }
                if let result { Card { Label(result, systemImage: "checkmark.circle.fill").foregroundStyle(Color.income) } }
                if let error { Card { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.alert) } }
            }
            .padding()
        }
        .background(Color.canvas)
        .navigationTitle("Import")
        .task { await loadAccounts() }
        .fileImporter(isPresented: $showPicker, allowedContentTypes: Self.types, allowsMultipleSelection: false) { res in
            Task { await picked(res) }
        }
    }

    private static var types: [UTType] {
        var t: [UTType] = [.commaSeparatedText, .plainText, .text, .data]
        if let ofx = UTType(filenameExtension: "ofx") { t.append(ofx) }
        if let qfx = UTType(filenameExtension: "qfx") { t.append(qfx) }
        return t
    }

    private var canImport: Bool {
        guard !accountId.isEmpty, totalRows > 0 else { return false }
        if kind == "csv" {
            let hasAmount = mapping["amount"] != nil || (mapping["debit"] != nil || mapping["credit"] != nil)
            return mapping["date"] != nil && mapping["description"] != nil && hasAmount
        }
        return true
    }

    private var mappingCard: some View {
        Card("3 · Match columns") {
            ForEach(fields, id: \.key) { f in
                Picker(f.label + (f.required ? " *" : ""), selection: Binding(
                    get: { mapping[f.key] ?? "" },
                    set: { mapping[f.key] = $0.isEmpty ? nil : $0 }
                )) {
                    Text("—").tag("")
                    ForEach(headers, id: \.self) { Text($0).tag($0) }
                }
            }
            Picker("Positive amounts are", selection: $convention) {
                Text("Expenses").tag("positive_is_expense")
                Text("Income").tag("positive_is_income")
            }
        }
    }

    private var previewCard: some View {
        Card("Preview", trailing: AnyView(Text("\(totalRows) rows").font(.footnote).foregroundStyle(.secondary))) {
            ForEach(Array(sampleRows.prefix(5).enumerated()), id: \.offset) { _, row in
                VStack(alignment: .leading, spacing: 2) {
                    Text(row[mapping["description"] ?? "Description"] ?? row.values.first ?? "").font(.subheadline).lineLimit(1)
                    Text("\(row[mapping["date"] ?? "Date"] ?? "") · \(row[mapping["amount"] ?? "Amount"] ?? "")")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Divider()
            }
        }
    }

    private func duplicateCard(_ info: (dupes: Int, unique: Int)) -> some View {
        Card("Possible duplicates") {
            Text("\(info.dupes) of these look like transactions you already have. \(info.unique) are new.").font(.subheadline)
            HStack {
                Button("Import only the new ones") { Task { await runImport(skipDuplicates: true) } }.buttonStyle(.borderedProminent)
            }
        }
    }

    // MARK: Actions

    private func loadAccounts() async {
        if let list: [ImportAccount] = try? await api.get("api/native/import/accounts") { accounts = list }
    }

    private func picked(_ res: Result<[URL], Error>) async {
        error = nil; result = nil; duplicateInfo = nil
        guard case .success(let urls) = res, let url = urls.first else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { error = "Couldn't read that file."; return }
        if data.count > 10 * 1024 * 1024 { error = "File must be under 10MB."; return }
        fileData = data
        fileName = url.lastPathComponent
        working = true
        defer { working = false }
        do {
            let json = try await api.upload("api/import", fields: ["step": "preview"], file: data, filename: fileName)
            kind = (json["type"] as? String) ?? "csv"
            headers = (json["headers"] as? [String]) ?? []
            sampleRows = (json["rows"] as? [[String: Any]])?.map { $0.mapValues { "\($0)" } } ?? []
            totalRows = (json["totalRows"] as? Int) ?? sampleRows.count
            mapping = [:]
            if let sug = json["suggestedMapping"] as? [String: Any] {
                for (k, v) in sug { if let s = v as? String, headers.contains(s) { mapping[k] = s } }
            }
        } catch {
            fileData = nil
            self.error = error.localizedDescription
        }
    }

    private func runImport(skipDuplicates: Bool) async {
        guard let data = fileData else { return }
        working = true
        error = nil
        defer { working = false }
        var form: [String: String] = ["step": "import", "accountId": accountId, "skipDuplicates": skipDuplicates ? "true" : "false"]
        if kind == "csv" {
            form["convention"] = convention
            if let m = try? JSONSerialization.data(withJSONObject: mapping), let s = String(data: m, encoding: .utf8) { form["mapping"] = s }
        }
        do {
            let json = try await api.upload("api/import", fields: form, file: data, filename: fileName)
            if (json["status"] as? String) == "duplicates_found" {
                duplicateInfo = (json["duplicateCount"] as? Int ?? 0, json["uniqueCount"] as? Int ?? 0)
                return
            }
            duplicateInfo = nil
            let imported = json["imported"] as? Int ?? 0
            let skipped = json["skipped"] as? Int ?? 0
            let bad = json["unparseableCount"] as? Int ?? 0
            result = "Imported \(imported)" + (skipped > 0 ? ", skipped \(skipped) duplicates" : "") + (bad > 0 ? ", \(bad) rows couldn't be read" : "")
            fileData = nil
            fileName = ""
            totalRows = 0
        } catch { self.error = error.localizedDescription }
    }
}
