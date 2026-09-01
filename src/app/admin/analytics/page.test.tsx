import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

const mocks = vi.hoisted(() => ({ authorizeAdminPage: vi.fn(), fetchAuthQuery: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/admin/server", () => ({ authorizeAdminPage: mocks.authorizeAdminPage }));
vi.mock("@/lib/auth-server", () => ({ fetchAuthQuery: mocks.fetchAuthQuery }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/components/admin/analytics-charts", () => ({ AnalyticsCharts: (props: Record<string, unknown>) => <section aria-label="Lazy analytics charts" data-props={JSON.stringify(props)} /> }));

import AnalyticsPage from "./page";

beforeEach(() => {
  mocks.authorizeAdminPage.mockReset();
  mocks.fetchAuthQuery.mockReset();
  mocks.redirect.mockReset();
  mocks.authorizeAdminPage.mockResolvedValue({ status: "authorized", currentAdmin: { userId: "auditor", roles: ["auditor"] } });
  mocks.fetchAuthQuery.mockResolvedValue({
    page: [{ id: "metric-1", day: "2026-07-28", jurisdictionCode: "GH", totalQuestions: 15, successCount: 14, failureCount: 1, abortedCount: 0, providerFailureCount: 1, noResultCount: 3, p50UpperBoundMs: 500, p95UpperBoundMs: 1000, updatedAt: Date.now() }],
    isDone: false,
    continueCursor: "next-metrics",
  });
  mocks.redirect.mockImplementation(() => { throw new Error("NEXT_REDIRECT"); });
});
afterEach(cleanup);

describe("admin analytics page", () => {
  it("requests only the bounded daily aggregate register and preserves filters in pagination", async () => {
    render(await AnalyticsPage({ searchParams: Promise.resolve({ cursor: "current", jurisdiction: "jurisdiction-ghana", from: "2026-07-01", to: "2026-07-28" }) }));
    expect(getFunctionName(mocks.fetchAuthQuery.mock.calls[0][0])).toBe("admin/analytics:listDailyMetrics");
    expect(mocks.fetchAuthQuery.mock.calls[0][1]).toEqual({
      paginationOpts: { numItems: 30, cursor: "current" },
      jurisdictionId: "jurisdiction-ghana",
      jurisdictionCode: null,
      fromDay: "2026-07-01",
      toDay: "2026-07-28",
    });
    expect(screen.getByRole("heading", { name: "Operational analytics" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Lazy analytics charts" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Lazy analytics charts" })).toHaveAttribute("data-props", JSON.stringify({ jurisdictionId: "jurisdiction-ghana", jurisdictionCode: null, fromDay: "2026-07-01", toDay: "2026-07-28" }));
    expect(screen.getByText("Questions on this page")).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Provider failures" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Next metrics page" })).toHaveAttribute("href", expect.stringContaining("jurisdiction=jurisdiction-ghana"));
    expect(screen.getByRole("link", { name: "Next metrics page" })).toHaveAttribute("href", expect.stringContaining("cursor=next-metrics"));
  });

  it("rejects roles without analytics read before fetching aggregates", async () => {
    mocks.authorizeAdminPage.mockResolvedValue({ status: "authorized", currentAdmin: { userId: "support", roles: ["support_agent"] } });
    let failure: unknown;
    try { await AnalyticsPage({ searchParams: Promise.resolve({}) }); } catch (error) { failure = error; }
    expect(failure === undefined).toBe(false);
    expect(mocks.redirect).toHaveBeenCalledWith("/admin/forbidden");
    expect(mocks.fetchAuthQuery).not.toHaveBeenCalled();
  });
});
