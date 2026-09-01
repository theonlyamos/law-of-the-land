import { cleanup, render, screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorizeAdminPage: vi.fn(), fetchAuthQuery: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/admin/server", () => ({ authorizeAdminPage: mocks.authorizeAdminPage }));
vi.mock("@/lib/auth-server", () => ({ fetchAuthQuery: mocks.fetchAuthQuery }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/components/admin/billing-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/admin/billing-actions")>();
  return { ...actual, BillingActions: ({ userId }: { userId: string }) => <span>Actions for {userId}</span> };
});

import AdminBillingPage from "./page";

const observedAt = Date.parse("2026-08-15T12:00:00.000Z");
const allowance = {
  userId: "customer-1",
  used: 0,
  baseLimit: 10,
  effectiveLimit: 25,
  allowed: true,
  canRecord: true,
  override: { id: "override-1", limit: 25, startsAt: observedAt - 1_000, expiresAt: observedAt + 60_000, grantedBy: "billing-manager-1", reason: "Temporary remediation" },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(observedAt);
  mocks.authorizeAdminPage.mockResolvedValue({ status: "authorized", currentAdmin: { userId: "billing-manager-1", roles: ["billing_manager"] } });
  mocks.redirect.mockImplementation(() => { throw new Error("NEXT_REDIRECT"); });
  mocks.fetchAuthQuery.mockImplementation(async (query) => getFunctionName(query) === "admin/billing:listSubscriptions"
    ? { page: [{ ...allowance, plan: "free", status: null, currentPeriodStart: null, currentPeriodEnd: null }], isDone: true, continueCursor: "" }
    : { page: [allowance], isDone: true, continueCursor: "" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("billing register", () => {
  it("loads both server registers at one explicit observation time", async () => {
    render(await AdminBillingPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getAllByText("0 / 25")).toHaveLength(2);
    expect(mocks.fetchAuthQuery.mock.calls.map(([query, args]) => ({ name: getFunctionName(query), now: args.now }))).toEqual([
      { name: "admin/billing:listSubscriptions", now: observedAt },
      { name: "admin/billing:listUsage", now: observedAt },
    ]);
  });
});
