import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

const convexMocks = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock("convex/react", () => ({ useQuery: convexMocks.useQuery }));
import { AnalyticsCharts } from "./analytics-charts";

let observerCallback: IntersectionObserverCallback;

beforeEach(() => {
  convexMocks.useQuery.mockReset();
  convexMocks.useQuery.mockImplementation((_reference, args) =>
    args === "skip" ? undefined : { page: metrics, isDone: true, continueCursor: "" },
  );
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
  { id: "metric-1", day: "2026-07-27", jurisdictionCode: "GH", totalQuestions: 10, failureCount: 9, providerFailureCount: 2, noResultCount: 1, p95UpperBoundMs: 2500 },
  { id: "metric-2", day: "2026-07-28", jurisdictionCode: "GH", totalQuestions: 15, failureCount: 8, providerFailureCount: 1, noResultCount: 3, p95UpperBoundMs: 1000 },
];

describe("analytics charts", () => {
  it("separates and labels stable-ID and legacy series even when they share a country code", async () => {
    convexMocks.useQuery.mockImplementation((_reference, args) => args === "skip" ? undefined : {
      page: [
        { ...metrics[0], id: "stable-1", jurisdictionId: "jurisdiction-ghana", jurisdictionName: "Ghana" },
        { ...metrics[1], id: "stable-2", jurisdictionId: "jurisdiction-ghana", jurisdictionName: "Ghana" },
        { ...metrics[0], id: "other-id", jurisdictionId: "jurisdiction-other-ghana", jurisdictionName: "Ghana", totalQuestions: 7 },
        { ...metrics[1], id: "legacy-gh", totalQuestions: 3 },
      ],
      isDone: true,
      continueCursor: "",
    });
    render(<AnalyticsCharts jurisdictionId={null} jurisdictionCode={null} fromDay="2026-07-01" toDay="2026-07-28" />);
    await act(async () => {
      observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    const stable = await screen.findByRole("region", { name: "Ghana — stable ID jurisdiction-ghana" });
    const otherStable = screen.getByRole("region", { name: "Ghana — stable ID jurisdiction-other-ghana" });
    const legacy = screen.getByRole("region", { name: "Legacy GH" });
    expect(within(stable).getByText(/15 questions/)).toBeVisible();
    expect(within(otherStable).getByText(/7 questions/)).toBeVisible();
    expect(within(legacy).getByText(/3 questions/)).toBeVisible();
  });

  it("does not import or render chart graphics until the section enters view", async () => {
    render(<AnalyticsCharts jurisdictionId="jurisdiction-ghana" jurisdictionCode={null} fromDay="2026-07-01" toDay="2026-07-28" />);
    expect(screen.getByText("Charts load when this section enters view.")).toBeVisible();
    expect(screen.queryByRole("img", { name: "Question volume and failures by UTC day" })).not.toBeInTheDocument();
    expect(convexMocks.useQuery).toHaveBeenCalledTimes(1);
    expect(convexMocks.useQuery.mock.calls[0][1]).toBe("skip");

    await act(async () => {
      observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    expect(await screen.findByRole("img", { name: "Question volume and failures by UTC day" })).toBeVisible();
    expect(getFunctionName(convexMocks.useQuery.mock.calls.at(-1)![0])).toBe("admin/analytics:listDailyMetrics");
    expect(convexMocks.useQuery.mock.calls.at(-1)![1]).toEqual({ paginationOpts: { numItems: 50, cursor: null }, jurisdictionId: "jurisdiction-ghana", jurisdictionCode: null, fromDay: "2026-07-01", toDay: "2026-07-28" });
  });

  it("uses labels and line patterns so status is not communicated by color alone", async () => {
    render(<AnalyticsCharts jurisdictionId="jurisdiction-ghana" jurisdictionCode={null} fromDay="2026-07-01" toDay="2026-07-28" />);
    await act(async () => {
      observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(await screen.findByText("Solid — questions")).toBeVisible();
    expect(screen.getByText("Dashed — provider failures")).toBeVisible();
    expect(screen.getByText("July 28")).toBeVisible();
    expect(screen.getByText("15 questions, 1 provider failure, 3 empty results, p95 ≤ 1,000 ms")).toBeVisible();
  });
});
