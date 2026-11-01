/** @vitest-environment jsdom */
import { describe, it, expect, beforeAll } from "vitest";
import { render } from "@testing-library/react";
import { RecurringHistoryChart } from "./recurring-history-chart";

beforeAll(() => {
  // Recharts' responsive container measures with ResizeObserver, which jsdom lacks.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

describe("RecurringHistoryChart", () => {
  it("renders with a projected final point without throwing", () => {
    const { container } = render(
      <RecurringHistoryChart
        points={[
          { month: "2026-09", amount: 9000, projected: false },
          { month: "2026-10", amount: 0, projected: false },
          { month: "2026-11", amount: 9220, projected: true },
        ]}
      />,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with no history", () => {
    const { container } = render(<RecurringHistoryChart points={[]} />);
    expect(container.firstChild).toBeTruthy();
  });
});
