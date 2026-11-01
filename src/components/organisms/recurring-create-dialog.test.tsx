/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const createRecurringTransaction = vi.fn();
vi.mock("@/actions/recurring", () => ({
  createRecurringTransaction: (...args: unknown[]) => createRecurringTransaction(...args),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

import { RecurringCreateDialog } from "./recurring-create-dialog";

beforeEach(() => createRecurringTransaction.mockReset());

function open() {
  render(<RecurringCreateDialog categoryGroups={[]} />);
  fireEvent.click(screen.getByRole("button", { name: /add recurring/i }));
}

describe("RecurringCreateDialog", () => {
  it("rejects a blank name without calling the action", async () => {
    open();
    fireEvent.change(await screen.findByLabelText("Amount ($)"), { target: { value: "12.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(createRecurringTransaction).not.toHaveBeenCalled();
  });

  it("sends the amount as integer cents", async () => {
    createRecurringTransaction.mockResolvedValue({ success: true, recurringId: "r1" });
    open();
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Gym" } });
    fireEvent.change(screen.getByLabelText("Amount ($)"), { target: { value: "12.50" } });
    fireEvent.change(screen.getByLabelText("Next payment"), { target: { value: "2026-11-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(createRecurringTransaction).toHaveBeenCalledTimes(1));
    expect(createRecurringTransaction.mock.calls[0][0]).toMatchObject({
      name: "Gym", amount: 1250, nextDate: "2026-11-20", frequency: "monthly", categoryId: null, accountId: null,
    });
  });
});
