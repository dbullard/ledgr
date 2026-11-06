import SwiftUI

/// One-line text prompt used for names and patterns.
struct NamePrompt: Identifiable {
    enum Kind {
        case newCategory(groupId: String, income: Bool)
        case renameCategory(id: String)
        case newGroup
        case renameGroup(id: String)
    }
    let id = UUID()
    let title: String
    let initial: String
    let kind: Kind
}

struct CategoriesView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var connection: Connection
    @State private var groups: [CategoryGroup] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var prompt: NamePrompt?
    @State private var message: String?

    var body: some View {
        ScrollView {
            if loaded {
                VStack(spacing: 16) {
                    if let message { Text(message).font(.footnote).foregroundStyle(Color.alert).frame(maxWidth: .infinity, alignment: .leading) }
                    ForEach(groups) { group in groupCard(group) }
                }
                .padding()
            } else if let error {
                ErrorState(message: error) { Task { await load() } }
            } else {
                ProgressView().padding(.top, 80)
            }
        }
        .background(Color.canvas)
        .navigationTitle("Categories")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { prompt = NamePrompt(title: "New category group", initial: "", kind: .newGroup) } label: { Image(systemName: "folder.badge.plus") }
                    .help("New group")
            }
        }
        .refreshable { await load() }
        .task(id: connection.active) { await load() }
        .sheet(item: $prompt) { p in
            NameSheet(prompt: p) { text in await apply(p, text) }
                .presentationDetents([.height(220)])
        }
    }

    private func groupCard(_ g: CategoryGroup) -> some View {
        Card(g.name, trailing: AnyView(
            Menu {
                Button("Add category") { prompt = NamePrompt(title: "New category in \(g.name)", initial: "", kind: .newCategory(groupId: g.id, income: false)) }
                Button("Add income category") { prompt = NamePrompt(title: "New income category", initial: "", kind: .newCategory(groupId: g.id, income: true)) }
                if g.isSystem != true {
                    Button("Rename group") { prompt = NamePrompt(title: "Rename group", initial: g.name, kind: .renameGroup(id: g.id)) }
                    Menu("Merge into…") {
                        ForEach(groups.filter { $0.id != g.id }) { t in
                            Button(t.name) { Task { await post("api/native/category-groups/\(g.id)/merge", ["targetId": t.id]) } }
                        }
                    }
                    Button("Delete group", role: .destructive) { Task { await remove("api/native/category-groups/\(g.id)") } }
                }
            } label: { Image(systemName: "ellipsis.circle") }
            .menuStyle(.borderlessButton)
            .fixedSize()
        )) {
            if g.categories.isEmpty { Text("No categories").foregroundStyle(.secondary) }
            ForEach(g.categories) { c in
                HStack(spacing: 12) {
                    CategoryBadge(icon: c.icon, size: 32)
                    Text(c.name).font(.body)
                    if c.excludeFromSpending == true { Text("Excluded").font(.caption2).foregroundStyle(.secondary) }
                    if c.isIncome { Text("Income").font(.caption2).padding(.horizontal, 6).padding(.vertical, 2).background(Color.income.opacity(0.15), in: Capsule()).foregroundStyle(Color.income) }
                    Spacer()
                    if c.isSystem != true {
                        Menu {
                            Button("Rename") { prompt = NamePrompt(title: "Rename category", initial: c.name, kind: .renameCategory(id: c.id)) }
                            Menu("Move to group") {
                                ForEach(groups.filter { $0.id != g.id }) { t in
                                    Button(t.name) { Task { await patch("api/native/categories/\(c.id)", ["groupId": t.id]) } }
                                }
                            }
                            Menu("Merge into…") {
                                ForEach(groups) { t in
                                    Menu(t.name) {
                                        ForEach(t.categories.filter { $0.id != c.id }) { o in
                                            Button(o.name) { Task { await post("api/native/categories/\(c.id)/merge", ["targetId": o.id]) } }
                                        }
                                    }
                                }
                            }
                            Button(c.excludeFromSpending == true ? "Include in spending" : "Exclude from spending") {
                                Task { await patch("api/native/categories/\(c.id)", ["excludeFromSpending": c.excludeFromSpending != true]) }
                            }
                            Button("Delete", role: .destructive) { Task { await remove("api/native/categories/\(c.id)") } }
                        } label: { Image(systemName: "ellipsis") }
                        .menuStyle(.borderlessButton)
                        .fixedSize()
                    }
                }
                if c.id != g.categories.last?.id { Divider() }
            }
        }
    }

    private func load() async {
        do {
            groups = try await api.get("api/native/categories")
            loaded = true
            error = nil
        } catch APIError.unauthorized {
        } catch {
            if !loaded { self.error = error.localizedDescription }
        }
    }

    private func apply(_ p: NamePrompt, _ text: String) async -> String? {
        do {
            switch p.kind {
            case .newCategory(let gid, let income):
                try await api.post("api/native/categories", body: ["name": text, "groupId": gid, "isIncome": income])
            case .renameCategory(let id):
                let _: Ok = try await api.patch("api/native/categories/\(id)", body: ["name": text])
            case .newGroup:
                try await api.post("api/native/category-groups", body: ["name": text])
            case .renameGroup(let id):
                let _: Ok = try await api.patch("api/native/category-groups/\(id)", body: ["name": text])
            }
            await load()
            return nil
        } catch { return error.localizedDescription }
    }

    private func patch(_ path: String, _ body: [String: Any]) async {
        do { let _: Ok = try await api.patch(path, body: body); message = nil; await load() }
        catch { message = error.localizedDescription }
    }

    private func post(_ path: String, _ body: [String: Any]) async {
        do { try await api.post(path, body: body); message = nil; await load() }
        catch { message = error.localizedDescription }
    }

    private func remove(_ path: String) async {
        do {
            try await api.delete(path)
            message = nil
            await load()
        } catch { message = error.localizedDescription }
    }
}

struct NameSheet: View {
    let prompt: NamePrompt
    let onSave: (String) async -> String?
    @State private var text = ""
    @State private var error: String?
    @State private var working = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(prompt.title).font(.title3.weight(.semibold))
            TextField("Name", text: $text).textFieldStyle(.roundedBorder)
            if let error { Text(error).font(.caption).foregroundStyle(Color.alert) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save") {
                    Task {
                        working = true
                        error = await onSave(text.trimmingCharacters(in: .whitespaces))
                        working = false
                        if error == nil { dismiss() }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || working)
            }
        }
        .padding(20)
        .onAppear { text = prompt.initial }
    }
}

// MARK: Rules

struct CategoryRuleModel: Codable, Identifiable, Hashable {
    let id: String
    let categoryId: String
    let categoryName: String
    let matchField: String
    let matchPattern: String
    let priority: Int
}

struct RulesView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var connection: Connection
    @State private var rules: [CategoryRuleModel] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var editing: RuleDraft?

    var body: some View {
        ScrollView {
            if loaded {
                VStack(spacing: 16) {
                    Text("Rules send transactions to a category by matching their name or merchant. Higher priority wins.")
                        .font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                    Card("Category rules", trailing: AnyView(Text("\(rules.count)").font(.footnote).foregroundStyle(.secondary))) {
                        if rules.isEmpty { Text("No rules yet.").foregroundStyle(.secondary) }
                        ForEach(rules) { r in
                            Button { editing = RuleDraft(rule: r) } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("\"\(r.matchPattern)\"").font(.body.weight(.medium)).lineLimit(1)
                                        Text("\(r.matchField == "merchant" ? "Merchant" : "Name") contains · priority \(r.priority)")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(r.categoryName).font(.subheadline).foregroundStyle(Color.accentColor)
                                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            if r.id != rules.last?.id { Divider() }
                        }
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
        .navigationTitle("Rules")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { editing = RuleDraft() } label: { Image(systemName: "plus") }
            }
        }
        .refreshable { await load() }
        .task(id: connection.active) { await load() }
        .sheet(item: $editing) { draft in
            RuleEditor(draft: draft) { await load() }
                .presentationDetents([.large])
        }
    }

    private func load() async {
        do {
            rules = try await api.get("api/native/category-rules")
            loaded = true
            error = nil
        } catch APIError.unauthorized {
        } catch {
            if !loaded { self.error = error.localizedDescription }
        }
    }
}

struct RuleDraft: Identifiable {
    let id = UUID()
    var ruleId: String?
    var pattern = ""
    var field = "name"
    var priority = 10
    var categoryId = ""

    init() {}
    init(rule: CategoryRuleModel) {
        ruleId = rule.id
        pattern = rule.matchPattern
        field = rule.matchField
        priority = rule.priority
        categoryId = rule.categoryId
    }
}

struct RuleEditor: View {
    @State var draft: RuleDraft
    let onDone: () async -> Void
    @EnvironmentObject var api: API
    @Environment(\.dismiss) private var dismiss
    @State private var groups: [CategoryGroup] = []
    @State private var error: String?
    @State private var working = false

    init(draft: RuleDraft, onDone: @escaping () async -> Void) {
        _draft = State(initialValue: draft)
        self.onDone = onDone
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(draft.ruleId == nil ? "New rule" : "Edit rule").font(.title3.weight(.semibold))
            Picker("Match on", selection: $draft.field) {
                Text("Name").tag("name")
                Text("Merchant").tag("merchant")
            }
            .pickerStyle(.segmented)
            TextField("Contains…", text: $draft.pattern).textFieldStyle(.roundedBorder)
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
            Picker("Category", selection: $draft.categoryId) {
                Text("Choose…").tag("")
                ForEach(groups) { g in
                    Section(g.name) { ForEach(g.categories) { Text($0.name).tag($0.id) } }
                }
            }
            Stepper("Priority: \(draft.priority)", value: $draft.priority, in: 0...999)
            if let error { Text(error).font(.caption).foregroundStyle(Color.alert) }
            HStack {
                if let id = draft.ruleId {
                    Button("Delete", role: .destructive) {
                        Task {
                            working = true
                            do { try await api.delete("api/native/category-rules/\(id)"); await onDone(); dismiss() }
                            catch { self.error = error.localizedDescription }
                            working = false
                        }
                    }
                }
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save") { Task { await save() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(draft.pattern.trimmingCharacters(in: .whitespaces).isEmpty || draft.categoryId.isEmpty || working)
            }
            Spacer()
        }
        .padding(20)
        .task { if let g: [CategoryGroup] = try? await api.get("api/native/categories") { groups = g } }
    }

    private func save() async {
        working = true
        defer { working = false }
        let body: [String: Any] = ["categoryId": draft.categoryId, "matchField": draft.field, "matchPattern": draft.pattern, "priority": draft.priority]
        do {
            if let id = draft.ruleId {
                let _: Ok = try await api.patch("api/native/category-rules/\(id)", body: body)
            } else {
                try await api.post("api/native/category-rules", body: body)
            }
            await onDone()
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
