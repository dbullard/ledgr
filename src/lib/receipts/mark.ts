/**
 * Whether a list row shows the quiet "has a receipt" mark. Only rows from a
 * list that computes `hasReceipt` can show it (it is undefined elsewhere).
 */
export function showsReceiptMark(t: { hasReceipt?: boolean }): boolean {
  return t.hasReceipt === true;
}
