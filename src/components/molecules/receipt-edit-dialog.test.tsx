/**
 * @vitest-environment jsdom
 *
 * The edit form must send exactly what the person typed: cents for money,
 * thousandths for quantity, existing lines by id, new lines without one, and
 * nothing at all until Save.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReceiptEditData } from "@/lib/receipts/edit";

const fetchReceiptForEdit = vi.fn();
const saveReceiptEdits = vi.fn();
vi.mock("@/actions/receipt-edit", () => ({
  fetchReceiptForEdit: (...a: unknown[]) => fetchReceiptForEdit(...a),
  saveReceiptEdits: (...a: unknown[]) => saveReceiptEdits(...a),
}));

import { ReceiptEditDialog } from "./receipt-edit-dialog";

const data: ReceiptEditData = {
  receiptId: "r1",
  transactionId: "t1",
  totalCents: 1500,
  date: "2026-11-02",
  merchant: "Walmart",
  items: [
    { id: "i1", lineNo: 1, rawName: "MILK 1GAL", productName: "Milk", categoryId: null, categoryName: null, quantityMilli: 1000, totalCents: 399 },
  ],
  itemsTotalCents: 399,
  gapCents: 1101,
};

function renderDialog(onSaved = vi.fn(), onOpenChange = vi.fn()) {
  render(<ReceiptEditDialog receiptId="r1" categories={[]} open onOpenChange={onOpenChange} onSaved={onSaved} />);
  return { onSaved, onOpenChange };
}

beforeEach(() => {
  fetchReceiptForEdit.mockResolvedValue({ data });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ReceiptEditDialog", () => {
  it("opens filled with what was read, and writes nothing until Save", async () => {
    renderDialog();
    expect(await screen.findByLabelText("Total")).toHaveProperty("value", "15.00");
    expect(screen.getByLabelText("Date")).toHaveProperty("value", "2026-11-02");
    expect(screen.getByLabelText("Merchant")).toHaveProperty("value", "Walmart");
    expect(screen.getByLabelText("Price, line 1")).toHaveProperty("value", "3.99");
    fireEvent.change(screen.getByLabelText("Price, line 1"), { target: { value: "4.50" } });
    expect(saveReceiptEdits).not.toHaveBeenCalled();
  });

  it("shows how far the lines are from the total as the person edits", async () => {
    renderDialog();
    fireEvent.change(await screen.findByLabelText("Price, line 1"), { target: { value: "14.00" } });
    expect(screen.getByText(/Lines add up to \$14\.00/)).toBeTruthy();
    expect(screen.getByText(/\$1\.00 less than the total/)).toBeTruthy();
  });

  it("sends cents, thousandths, the existing line's id, and a new line without one", async () => {
    saveReceiptEdits.mockResolvedValue({ data });
    const { onSaved } = renderDialog();
    fireEvent.change(await screen.findByLabelText("Total"), { target: { value: "20.00" } });
    fireEvent.change(screen.getByLabelText("Quantity, line 1"), { target: { value: "1.5" } });
    fireEvent.change(screen.getByLabelText("Price, line 1"), { target: { value: "4.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Add line" }));
    fireEvent.change(screen.getByLabelText("Printed name, line 2"), { target: { value: "BAGS" } });
    fireEvent.change(screen.getByLabelText("Price, line 2"), { target: { value: "-0.10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveReceiptEdits).toHaveBeenCalledTimes(1));
    expect(saveReceiptEdits).toHaveBeenCalledWith("r1", {
      totalCents: 2000,
      date: "2026-11-02",
      merchant: "Walmart",
      items: [
        { id: "i1", rawName: "MILK 1GAL", productName: "Milk", categoryId: null, quantityMilli: 1500, totalCents: 450 },
        { rawName: "BAGS", productName: null, categoryId: null, quantityMilli: 1000, totalCents: -10 },
      ],
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("deleting the only line sends an empty item list", async () => {
    saveReceiptEdits.mockResolvedValue({ data });
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Delete line 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveReceiptEdits).toHaveBeenCalled());
    expect(saveReceiptEdits.mock.calls[0][1].items).toEqual([]);
  });

  it("shows the server's error, keeps the dialog open and does not report a save", async () => {
    saveReceiptEdits.mockResolvedValue({ error: "Date must be a real date (YYYY-MM-DD)" });
    const { onSaved, onOpenChange } = renderDialog();
    fireEvent.change(await screen.findByLabelText("Date"), { target: { value: "2026-02-30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Date must be a real date (YYYY-MM-DD)");
    expect(onSaved).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("refuses a missing price or zero quantity before calling the server", async () => {
    renderDialog();
    fireEvent.change(await screen.findByLabelText("Price, line 1"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Line 1: enter a price/);
    fireEvent.change(screen.getByLabelText("Price, line 1"), { target: { value: "3.99" } });
    fireEvent.change(screen.getByLabelText("Quantity, line 1"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Line 1: quantity must be more than zero/);
    expect(saveReceiptEdits).not.toHaveBeenCalled();
  });

  it("Cancel closes without saving", async () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(saveReceiptEdits).not.toHaveBeenCalled();
  });
});
