/** @vitest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const HONEYBOOK = {
  transactions: [
    {
      id: "txn-1",
      name: "HB Chris HB Honeybook INC",
      date: "2026-10-16",
      normalizedAmount: -21834,
      currency: "USD",
      categoryName: "Subscriptions",
    },
  ],
  accounts: [],
};

let resolveFetch: (value: unknown) => void;

beforeAll(() => {
  // cmdk and the dialog lean on browser APIs jsdom does not provide.
  Element.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

beforeEach(() => {
  vi.useFakeTimers();
  push.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openAndType(text: string) {
  const { CommandPalette } = await import("./command-palette");
  render(<CommandPalette open onOpenChange={() => {}} />);
  const input = screen.getByPlaceholderText(/Search transactions and accounts/);
  fireEvent.change(input, { target: { value: text } });
  return input;
}

describe("CommandPalette", () => {
  it("does not jump to an unrelated page when Enter is pressed before results arrive", async () => {
    const input = await openAndType("honeybook");

    // Enter lands inside the debounce window, before any request has returned.
    fireEvent.keyDown(input, { key: "Enter" });

    expect(push).not.toHaveBeenCalled();
  });

  it("does not jump to an unrelated page when nothing matches", async () => {
    const input = await openAndType("zzzz");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      resolveFetch({ ok: true, json: async () => ({ transactions: [], accounts: [] }) });
    });

    fireEvent.keyDown(input, { key: "Enter" });

    expect(push).not.toHaveBeenCalled();
    expect(screen.getByText("No matches.")).not.toBeNull();
  });

  it("opens the matching transaction on Enter once results arrive", async () => {
    const input = await openAndType("honeybook");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      resolveFetch({ ok: true, json: async () => HONEYBOOK });
    });

    expect(screen.getByText("HB Chris HB Honeybook INC")).not.toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });

    expect(push).toHaveBeenCalledWith("/transactions?txn=txn-1");
  });
});
