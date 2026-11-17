import SwiftUI

/// Where a category came from, when it was only a guess, plus a one-tap way to turn the
/// choice into a rule. Mirrors the web review card (`review-suggestion-note.tsx`).
struct GuessNote: View {
    let txn: Txn
    @EnvironmentObject var api: API
    @State private var saved = false
    @State private var matches: Int?
    @State private var applied: Int?
    @State private var working = false
    @State private var error: String?

    /// Category sources that are a guess rather than a decision someone made.
    private static let guessLabels: [String: String] = [
        "history": "Guessed from your past choices for this merchant",
        "ai": "Guessed by AI",
        "ai_low_confidence": "Best guess by AI, not sure",
    ]

    private var guess: String? { txn.categorySource.flatMap { Self.guessLabels[$0] } }
    private var pattern: String? { RulePattern.suggest(from: txn.name) }
    private var canMakeRule: Bool { txn.categoryId != nil && txn.categoryName != nil && !txn.isTransfer && pattern != nil }

    var body: some View {
        if guess != nil || canMakeRule {
            VStack(alignment: .leading, spacing: 6) {
                // Once a rule has filed this row, it is no longer a guess.
                if let guess, applied == nil { Text(guess).foregroundStyle(.secondary) }
                if canMakeRule, let pattern, let category = txn.categoryName {
                    if saved {
                        Text("Rule saved: “\(pattern)” will be filed under \(category).").foregroundStyle(.secondary)
                        if let applied {
                            Text("Filed \(applied) existing transaction\(applied == 1 ? "" : "s") under \(category).").foregroundStyle(.secondary)
                        } else if let matches, matches > 0 {
                            Button("Also file \(matches) existing transaction\(matches == 1 ? "" : "s") under \(category)") {
                                Task { await applyToExisting() }
                            }
                            .disabled(working)
                        }
                    } else {
                        Button("Always file “\(pattern)” under \(category)") { Task { await saveRule() } }
                            .disabled(working)
                    }
                }
                if let error { Text(error).foregroundStyle(Color.alert) }
            }
            .font(.footnote)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
        }
    }

    private var body_: [String: Any]? {
        guard let id = txn.categoryId, let pattern else { return nil }
        return ["categoryId": id, "matchField": "name", "matchPattern": pattern]
    }

    private func saveRule() async {
        guard var body = body_ else { return }
        working = true
        defer { working = false }
        error = nil
        do {
            body["priority"] = 0
            try await api.post("api/native/category-rules", body: body)
            saved = true
            let preview: RuleCount = try await api.postDecoded("api/native/category-rules/preview", body: body_ ?? [:])
            matches = preview.count
        } catch APIError.unauthorized {
        } catch { self.error = error.localizedDescription }
    }

    private func applyToExisting() async {
        guard let body = body_ else { return }
        working = true
        defer { working = false }
        error = nil
        do {
            let result: RuleApplied = try await api.postDecoded("api/native/category-rules/apply", body: body)
            applied = result.updated
            // Lets lists, the dashboard and the review badge pick up the change.
            api.noteChanged()
        } catch APIError.unauthorized {
        } catch { self.error = error.localizedDescription }
    }
}

private struct RuleCount: Decodable { let count: Int }
private struct RuleApplied: Decodable { let updated: Int }

/// The text to offer as a rule's match pattern: the leading words of the bank description, before
/// any store number or symbol. Port of `suggestRulePattern` in the server's history-suggester; keep
/// the two in step. Returns nil when nothing safe is left, because rules match by substring and a
/// short pattern would hit unrelated merchants.
enum RulePattern {
    private static let minLength = 4

    static func suggest(from name: String) -> String? {
        var text = name
        // Payment-processor prefixes banks glue onto the merchant ("SQ *", "TST*", "PAYPAL *").
        if let r = text.range(of: #"^(?:sq|tst|sp|pp|paypal|pos|dd)\s*\*\s*"#, options: [.regularExpression, .caseInsensitive]) {
            text.removeSubrange(r)
        }
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let r = text.range(of: #"^[A-Za-z][A-Za-z'&.\- ]*"#, options: .regularExpression) else { return nil }
        let lead = text[r].trimmingCharacters(in: .whitespaces)
        return lead.count >= minLength ? lead : nil
    }
}
