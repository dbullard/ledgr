export interface MatchRow {
  key: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /** Integer cents, same sign convention on both sides. */
  amount: number;
}

/** Banks, files and aggregators date the same transaction differently (posted vs transacted). */
export const NEAR_MATCH_WINDOW_DAYS = 3;

const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

/**
 * Pairs incoming rows with already-stored rows that are almost certainly the
 * same transaction: identical amount, dates within a few days. Descriptions are
 * ignored on purpose, because an aggregator and the bank's own export word them
 * differently. Matching is one-to-one (each stored row absorbs at most one
 * incoming row, closest date first) so two genuine same-amount purchases are
 * not collapsed into one. Returns incomingKey -> existingKey.
 */
export function matchNearDuplicates(incoming: MatchRow[], existing: MatchRow[]): Map<string, string> {
  const candidates: { inKey: string; exKey: string; gap: number }[] = [];
  const byAmount = new Map<number, MatchRow[]>();
  for (const e of existing) {
    const list = byAmount.get(e.amount);
    if (list) list.push(e);
    else byAmount.set(e.amount, [e]);
  }
  for (const row of incoming) {
    for (const e of byAmount.get(row.amount) ?? []) {
      const gap = Math.abs(dayNumber(row.date) - dayNumber(e.date));
      if (gap <= NEAR_MATCH_WINDOW_DAYS) candidates.push({ inKey: row.key, exKey: e.key, gap });
    }
  }
  candidates.sort((a, b) => a.gap - b.gap);

  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const c of candidates) {
    if (result.has(c.inKey) || used.has(c.exKey)) continue;
    result.set(c.inKey, c.exKey);
    used.add(c.exKey);
  }
  return result;
}
