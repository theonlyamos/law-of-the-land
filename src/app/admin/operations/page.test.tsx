import { cleanup, render, screen, within } from "@testing-library/react";
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
    if (name.endsWith("listIntegrationHealth")) return Promise.resolve({ page: [{ id: "legal-search", label: "Gemini legal search and indexing", configured: true, status: "configured" }], isDone: true, continueCursor: "" });
    if (name.endsWith("listJobs")) return Promise.resolve({ page: [
      { id: "job-1", type: "gemini_index_document", targetType: "documentVersion", targetId: "safe-target", status: "waiting_provider", attemptCount: 1, nextAttemptAt: Date.now() + 5_000, correlationId: "job_safe", createdAt: 1, updatedAt: 2 },
      { id: "job-2", type: "gemini_index_document", targetType: "documentVersion", targetId: "review-target", status: "manual_review", attemptCount: 4, lastErrorKind: "timeout", correlationId: "job_review", createdAt: 1, updatedAt: 2 },
    ], isDone: true, continueCursor: "" });
    return Promise.resolve({ queryRunDays: 90, exportHours: 24, unattachedStorageHours: 24, maxPerInvocation: 200, lastSuccessfulAt: 1, deletedTotal: 205 });
  });
  mocks.redirect.mockImplementation(() => { throw new Error("NEXT_REDIRECT"); });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("operations register", () => {
  it("loads bounded jobs and active retention policy without payloads, errors, or provider URLs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));
    render(await OperationsPage({ searchParams: Promise.resolve({ status: "waiting_provider" }) }));
    expect(mocks.fetchAuthQuery.mock.calls.map((call) => getFunctionName(call[0]))).toEqual(expect.arrayContaining(["admin/jobs:listJobs", "admin/operations:getRetentionPolicy"]));
    expect(screen.getByRole("heading", { name: "Operations" })).toBeVisible();
    const jobsTable = screen.getByRole("table", { name: "Provider jobs" });
    expect(jobsTable).toBeVisible();
    expect(within(jobsTable).getAllByText("Index document")).toHaveLength(2);
    expect(within(jobsTable).getByText("Waiting for Gemini")).toBeVisible();
    expect(within(jobsTable).getByText("Next check in 5 seconds")).toBeVisible();
    expect(within(jobsTable).getByText("Indexing needs review")).toBeVisible();
    expect(within(jobsTable).getByText("Search is paused until an administrator reviews the job.")).toBeVisible();
    expect(screen.getByText("Gemini legal search and indexing")).toBeVisible();
    expect(screen.getByRole("table", { name: "Integration configuration" })).toBeVisible();
    expect(screen.getByText("Configured")).toBeVisible();
    expect(screen.getByText("90 days")).toBeVisible();
    expect(document.body.textContent).not.toContain("payload");
    expect(document.body.textContent).not.toContain("fileSearchStores/");
    expect(document.body.textContent).not.toContain("Ready");
  });

  it("presents only final Gemini job types and statuses without raw provider identifiers", async () => {
    const types = [
      "gemini_create_store", "gemini_index_document", "gemini_delete_document", "gemini_delete_store",
    ] as const;
    const statuses = [
      "queued", "running", "waiting_provider", "succeeded", "failed", "cancelled", "manual_review",
    ] as const;
    mocks.fetchAuthQuery.mockImplementation((reference: unknown) => {
      const name = getFunctionName(reference as never);
      if (name.endsWith("listIntegrationHealth")) return Promise.resolve({ page: [], isDone: true, continueCursor: "" });
      if (name.endsWith("listJobs")) {
        const page = types.map((type, index) => ({
          id: `job-${index}`,
          type,
          targetType: index === 0 ? "jurisdictionGeminiStore" : "documentVersion",
          targetId: `safe-target-${index}`,
          status: statuses[index % statuses.length],
          attemptCount: index,
          correlationId: `job_safe_${index}`,
          createdAt: index,
          updatedAt: index,
        }));
        Object.defineProperty(page, "filter", {
          value: () => page.slice(0, 1),
        });
        return Promise.resolve({ page, isDone: true, continueCursor: "" });
      }
      return Promise.resolve({ queryRunDays: 90, exportHours: 24, unattachedStorageHours: 24, maxPerInvocation: 200, lastSuccessfulAt: null, deletedTotal: 0 });
    });

    render(await OperationsPage({ searchParams: Promise.resolve({}) }));

    const jobsTable = screen.getByRole("table", { name: "Provider jobs" });
    for (const label of [
      "Set up jurisdiction search", "Index document", "Remove jurisdiction search store",
      "Queued", "Running", "Waiting for Gemini", "Succeeded",
    ]) expect(within(jobsTable).getAllByText(label).length).toBeGreaterThan(0);
    for (const index of types.keys()) {
      expect(within(jobsTable).getByText(`job_safe_${index}`)).toBeVisible();
    }
    for (const retiredLabel of [
      "Set up search resources", "Prepare document for search", "Publish indexed document",
      "Check provider work", "Waiting for provider",
    ]) expect(screen.queryByText(retiredLabel)).toBeNull();
  });
});
