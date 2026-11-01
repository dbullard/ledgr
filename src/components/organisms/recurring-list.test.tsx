/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RecurringGroups, RecurringRow } from "@/queries/recurring";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/recurrings",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/actions/recurring", () => ({}));

import { RecurringList } from "./recurring-list";

const row = (id: string, name: string, over: Partial<RecurringRow> = {}): RecurringRow => ({
  id, name, merchantName: null, categoryId: null, categoryName: "Subscriptions", categoryIcon: null,
  accountId: null, accountName: null, averageAmount: 1599, lastAmount: 1599, frequency: "monthly",
  nextDate: "2026-11-19", lastDate: null, isIncome: false, isActive: true, lifecycle: "active",
  source: "detected", matchName: name, matchMinAmount: null, matchMaxAmount: null, matchDayOfMonth: null,
  status: "upcoming", relativeDateLabel: "Nov 19", ...over,
});

const empty: RecurringGroups = { overdue: [], thisMonth: [], future: [], paused: [], archived: [] };

beforeAll(() => {
  // jsdom has no matchMedia; the list asks it whether to use the sheet layout.
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

describe("RecurringList", () => {
  it("shows only non-empty groups, in order, with overdue under 'This month'", () => {
    const groups: RecurringGroups = {
      ...empty,
      overdue: [row("1", "Netflix", { status: "overdue" })],
      thisMonth: [row("2", "Hulu")],
      future: [row("3", "Amazon Prime", { frequency: "yearly" })],
      archived: [row("4", "Old Gym", { lifecycle: "archived" })],
    };

    render(<RecurringList groups={groups} categoryGroups={[]} selected={null} />);

    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["This month", "In the future", "Archived"]);
    expect(screen.queryByText("Paused")).toBeNull();
    // Overdue items sit first inside "This month".
    const names = screen.getAllByRole("button", { name: /^Open / }).map((b) => b.getAttribute("aria-label"));
    expect(names.slice(0, 2)).toEqual(["Open Netflix", "Open Hulu"]);
  });
});
