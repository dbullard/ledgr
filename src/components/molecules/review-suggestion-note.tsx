"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { createCategoryRule } from "@/actions/category-rules";
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
      if ("error" in result) setError(result.error);
      else setSaved(true);
    });
  };

  return (
    <div className="space-y-1.5 text-xs" data-testid="review-suggestion-note">
      {guess && <p className="text-muted-foreground">{guess}</p>}
      {canMakeRule && (
        saved ? (
          <p className="text-muted-foreground" role="status">
            Rule saved: &ldquo;{pattern}&rdquo; will be filed under {transaction.categoryName}.
          </p>
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
