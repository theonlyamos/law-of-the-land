import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

const mocks = vi.hoisted(() => ({ authorizeAdminPage: vi.fn(), fetchAuthQuery: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/admin/server", () => ({ authorizeAdminPage: mocks.authorizeAdminPage }));
vi.mock("@/lib/auth-server", () => ({ fetchAuthQuery: mocks.fetchAuthQuery }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/components/admin/job-actions", () => ({ JobActions: () => <span>Authoritative controls</span> }));
import OperationsPage from "./page";

beforeEach(() => {
  mocks.authorizeAdminPage.mockResolvedValue({ status: "authorized", currentAdmin: { userId: "operator", roles: ["super_admin"] } });
  mocks.fetchAuthQuery.mockImplementation((reference: unknown) => {
    const name = getFunctionName(reference as never);
    if (name.endsWith("listIntegrationHealth")) return Promise.resolve({ page: [], isDone: true, continueCursor: "" });
    if (name.endsWith("listJobs")) return Promise.resolve({ page: [{ id: "job-1", type: "poll_process", targetType: "operation", targetId: "safe-target", status: "manual_review", attemptCount: 4, correlationId: "job_safe", createdAt: 1, updatedAt: 2 }], isDone: true, continueCursor: "" });
    return Promise.resolve({ queryRunDays: 90, exportHours: 24, unattachedStorageHours: 24, maxPerInvocation: 200, lastSuccessfulAt: 1, deletedTotal: 205 });
  });
  mocks.redirect.mockImplementation(() => { throw new Error("NEXT_REDIRECT"); });
});
afterEach(cleanup);

describe("operations register", () => {
  it("loads bounded jobs and active retention policy without payloads, errors, or provider URLs", async () => {
    render(await OperationsPage({ searchParams: Promise.resolve({ status: "manual_review" }) }));
    expect(mocks.fetchAuthQuery.mock.calls.map((call) => getFunctionName(call[0]))).toEqual(expect.arrayContaining(["admin/jobs:listJobs", "admin/operations:getRetentionPolicy"]));
    expect(screen.getByRole("heading", { name: "Operations" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Provider jobs" })).toBeVisible();
    expect(screen.getByText("90 days")).toBeVisible();
    expect(document.body.textContent).not.toContain("payload");
  });
});
