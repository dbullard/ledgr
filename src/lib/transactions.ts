export interface DateGroup<T extends { date: string }> {
  date: string;
  rows: T[];
}

export function groupByDate<T extends { date: string }>(rows: T[]): DateGroup<T>[] {
  const groups: DateGroup<T>[] = [];
  let current: DateGroup<T> | null = null;

  for (const row of rows) {
    if (current && current.date === row.date) {
      current.rows.push(row);
    } else {
      current = { date: row.date, rows: [row] };
      groups.push(current);
    }
  }

  return groups;
}

/**
 * Whether the detail panel sits beside the ledger rather than over it.
 *
 * On desktop the panel is a fixed-width column at the right edge. The ledger
 * reserves that column (and compacts its rows) so the Category and Amount
 * columns stay visible next to the panel instead of being covered by it. On
 * mobile the panel is a full-screen overlay, and the review dialogs replace it.
 * On a window too narrow to fit the compact columns beside it, the panel stays
 * an overlay rather than squeezing the description to nothing.
 */
export function isPanelDocked(opts: {
  panelOpen: boolean;
  isMobile: boolean;
  reviewMode: boolean;
  wideEnough: boolean;
}): boolean {
  return opts.panelOpen && !opts.isMobile && !opts.reviewMode && opts.wideEnough;
}

/** Narrowest viewport that fits the compact ledger beside the panel. */
export const DOCKED_PANEL_MIN_WIDTH = 1280;

/** Panel width (396) plus a 16px gutter. */
export const DOCKED_PANEL_RESERVE_CLASS = "pr-[412px]";
