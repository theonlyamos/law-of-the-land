import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsCharts } from "./analytics-charts";

let observerCallback: IntersectionObserverCallback;

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { observerCallback = callback; }
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() { return []; }
    root = null;
    rootMargin = "0px";
    thresholds = [0];
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const metrics = [
  { day: "2026-07-27", jurisdictionCode: "GH", totalQuestions: 10, failureCount: 2, noResultCount: 1, p95LatencyMs: 2500 },
  { day: "2026-07-28", jurisdictionCode: "GH", totalQuestions: 15, failureCount: 1, noResultCount: 3, p95LatencyMs: 1000 },
];

describe("analytics charts", () => {
  it("does not import or render chart graphics until the section enters view", async () => {
    render(<AnalyticsCharts metrics={metrics} />);
    expect(screen.getByText("Charts load when this section enters view.")).toBeVisible();
    expect(screen.queryByRole("img", { name: "Question volume and failures by UTC day" })).not.toBeInTheDocument();

    await act(async () => {
      observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    expect(await screen.findByRole("img", { name: "Question volume and failures by UTC day" })).toBeVisible();
  });

  it("uses labels and line patterns so status is not communicated by color alone", async () => {
    render(<AnalyticsCharts metrics={metrics} />);
    await act(async () => {
      observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(await screen.findByText("Solid — questions")).toBeVisible();
    expect(screen.getByText("Dashed — provider failures")).toBeVisible();
    expect(screen.getByText("July 28")).toBeVisible();
    expect(screen.getByText("15 questions, 1 provider failure, 3 empty results, p95 1,000 ms")).toBeVisible();
  });
});
