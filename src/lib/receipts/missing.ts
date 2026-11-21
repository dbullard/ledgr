/**
 * Whether a list row should show the quiet "no receipt" mark: a posted expense
 * that has no receipt attached. Receipts are optional, so this is only a hint.
 * Income, transfers and pending charges never get it, and neither does a row
 * from a list that does not compute `hasReceipt` (it is undefined there).
 */
export function needsReceipt(t: {
  hasReceipt?: boolean;
  normalizedAmount: number;
  isTransfer: boolean;
  pending: boolean;
}): boolean {
  return t.hasReceipt === false && t.normalizedAmount < 0 && !t.isTransfer && !t.pending;
}
