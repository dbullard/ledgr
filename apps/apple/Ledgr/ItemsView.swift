import SwiftUI
import Charts

struct ItemsView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var connection: Connection
    @State private var data: ItemsResponse?
    @State private var days = 90
    @State private var error: String?
    private let options = [(30, "30 days"), (90, "90 days"), (365, "1 year")]

    var body: some View {
        List {
            Section {
                Picker("Range", selection: $days) {
                    ForEach(options, id: \.0) { Text($0.1).tag($0.0) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            if let data {
                if data.byCategory.isEmpty {
                    Section {
                        ContentUnavailableView("No item data yet", systemImage: "cart", description: Text("Attach itemized receipts to see what you buy."))
                    }
                } else {
                    Section("Spend by category") {
                        Chart(data.byCategory.prefix(8)) { c in
                            BarMark(x: .value("Spend", Double(c.totalCents) / 100), y: .value("Category", c.label))
                                .foregroundStyle(Color.accentColor.gradient)
                                .cornerRadius(4)
                        }
                        .chartXAxis { AxisMarks { AxisValueLabel(format: .currency(code: "USD").notation(.compactName)) } }
                        .frame(height: CGFloat(min(data.byCategory.count, 8)) * 34 + 24)
                        .padding(.vertical, 6)
                    }
                    Section("Top items") {
                        ForEach(data.products) { p in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(p.name).lineLimit(2)
                                    Text("\(p.purchases)× · avg \(Fmt.money(p.avgUnitCents)) · last \(Fmt.shortDate(p.lastDate))")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(Fmt.money(p.totalCents)).monospacedDigit()
                            }
                        }
                    }
                }
            } else if let error {
                Section { ErrorState(message: error) { Task { await load() } } }
            } else {
                Section { ProgressView().frame(maxWidth: .infinity) }
            }
        }
        .navigationTitle("Items")
        .refreshable { await load() }
        .task(id: connection.active) { await load() }
        .onChange(of: days) { _, _ in Task { await load() } }
    }

    private func load() async {
        let to = Date()
        let from = to.addingTimeInterval(-Double(days) * 86_400)
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        do {
            data = try await api.get("api/native/items", query: ["from": f.string(from: from), "to": f.string(from: to)])
            error = nil
        } catch APIError.unauthorized {
        } catch {
            if data == nil { self.error = error.localizedDescription }
        }
    }
}
