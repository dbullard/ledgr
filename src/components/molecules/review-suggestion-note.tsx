"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { applyRuleToExisting, createCategoryRule, previewRuleApplication } from "@/actions/category-rules";
import { suggestRulePattern } from "@/lib/categorization/history-suggester";
import type { TransactionRow } from "@/queries/transactions";

const GUESS_LABEL: Record<string, string> = {
  history: "Guessed from your past choices for this merchant",
  ai: "Guessed by AI",
  ai_low_confidence: "Best guess by AI, not sure",
};

interface ReviewSuggestionNoteProps {
  transaction: TransactionRow;
}

/**
 * Says why the current category is only a guess, and offers to turn the
 * choice into a rule so the same merchant is filed correctly from now on.
 * Remount it per transaction and category (via `key`) so its saved/error
 * state never leaks from one card to the next.
 */
export function ReviewSuggestionNote({ transaction }: ReviewSuggestionNoteProps) {
  const [saved, setSaved] = useState(false);
  // Existing rows the new rule could also file: null until counted, then a number.
  const [matches, setMatches] = useState<number | null>(null);
  const [applied, setApplied] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const guess = transaction.categorySource ? GUESS_LABEL[transaction.categorySource] : undefined;
  const pattern = suggestRulePattern(transaction.name);
  const canMakeRule = !!transaction.categoryId && !transaction.isTransfer && !!pattern;

  if (!guess && !canMakeRule) return null;

  const saveRule = () => {
    if (!transaction.categoryId || !pattern) return;
    const categoryId = transaction.categoryId;
    setError(null);
    startTransition(async () => {
      const result = await createCategoryRule({
        categoryId,
        matchField: "name",
        matchPattern: pattern,
        priority: 0,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSaved(true);
      const preview = await previewRuleApplication({ categoryId, matchField: "name", matchPattern: pattern });
      if ("count" in preview) setMatches(preview.count);
    });
  };

  const applyToExisting = () => {
    if (!transaction.categoryId || !pattern) return;
    const categoryId = transaction.categoryId;
    setError(null);
    startTransition(async () => {
      const result = await applyRuleToExisting({ categoryId, matchField: "name", matchPattern: pattern });
      if ("error" in result) setError(result.error);
      else setApplied(result.updated);
    });
  };

  return (
    <div className="space-y-1.5 text-xs" data-testid="review-suggestion-note">
      {/* Once a rule has filed this row, it is no longer a guess. */}
      {guess && applied === null && <p className="text-muted-foreground">{guess}</p>}
      {canMakeRule && (
        saved ? (
          <div className="space-y-1" role="status">
            <p className="text-muted-foreground">
              Rule saved: &ldquo;{pattern}&rdquo; will be filed under {transaction.categoryName}.
            </p>
            {applied !== null ? (
              <p className="text-muted-foreground">
                Filed {applied} existing transaction{applied === 1 ? "" : "s"} under {transaction.categoryName}.
              </p>
            ) : matches ? (
              <Button variant="link" size="xs" className="h-auto p-0" onClick={applyToExisting} disabled={pending}>
                Also file {matches} existing transaction{matches === 1 ? "" : "s"} under {transaction.categoryName}
              </Button>
            ) : null}
          </div>
        ) : (
          <Button
            variant="link"
            size="xs"
            className="h-auto p-0"
            onClick={saveRule}
            disabled={pending}
          >
            Always file &ldquo;{pattern}&rdquo; under {transaction.categoryName}
          </Button>
        )
      )}
      {error && <p className="text-destructive" role="alert">{error}</p>}
    </div>
  );
}
