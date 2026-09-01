import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ update: vi.fn(), addNote: vi.fn(), create: vi.fn(), useMutation: vi.fn(), loadMore: vi.fn(), refresh: vi.fn() }));
vi.mock("convex/react", () => ({
  useMutation: mocks.useMutation,
  usePaginatedQuery: () => ({
    results: [{ id: "timeline_1", kind: "status", actorId: "admin_1", summary: "Status changed from open to investigating", createdAt: 1 }],
    status: "CanLoadMore",
    loadMore: mocks.loadMore,
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

import { IncidentActions, IncidentCreateForm } from "./incident-actions";

beforeEach(() => {
  mocks.update.mockReset().mockResolvedValue({});
  mocks.addNote.mockReset().mockResolvedValue({});
  mocks.create.mockReset().mockResolvedValue({});
  mocks.loadMore.mockReset();
  mocks.refresh.mockReset();
  mocks.useMutation.mockReset().mockImplementation((reference: never) => getFunctionName(reference).endsWith(":updateIncident") ? mocks.update : getFunctionName(reference).endsWith(":addIncidentNote") ? mocks.addNote : mocks.create);
});
afterEach(cleanup);

describe("incident administration controls", () => {
  it("creates a new incident through the permission-gated form", async () => {
    render(<IncidentCreateForm canWrite />);
    fireEvent.change(screen.getByLabelText("Incident title"), { target: { value: "GroundX callback backlog" } });
    fireEvent.change(screen.getByLabelText("Initial severity"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("Reason for opening incident"), { target: { value: "Callbacks exceeded the operational threshold" } });
    fireEvent.click(screen.getByRole("button", { name: "Open incident" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.create).toHaveBeenCalledWith({
      title: "GroundX callback backlog",
      severity: "high",
      reason: "Callbacks exceeded the operational threshold",
      idempotencyKey: expect.stringMatching(/^incident_create_/),
    });
  });

  it("starts from the current incident values and preserves status and severity while assigning an owner", async () => {
    const CurrentIncidentActions = IncidentActions as unknown as ComponentType<{ incidentId: never; canWrite: boolean; status: "open" | "investigating" | "monitoring" | "resolved"; severity: "low" | "medium" | "high" | "critical"; ownerId?: string }>;
    render(<CurrentIncidentActions incidentId={"incident_1" as never} canWrite status="investigating" severity="high" ownerId="admin_current" />);
    fireEvent.click(screen.getByText("Timeline and controls"));

    expect(await screen.findByText("Status changed from open to investigating")).toBeVisible();
    expect(screen.getByLabelText("Incident status")).toHaveValue("investigating");
    expect(screen.getByLabelText("Incident severity")).toHaveValue("high");
    expect(screen.getByLabelText("Assign owner ID")).toHaveValue("admin_current");
    fireEvent.change(screen.getByLabelText("Assign owner ID"), { target: { value: "admin_next" } });
    fireEvent.change(screen.getByLabelText("Reason for incident transition"), { target: { value: "Assign the active incident commander" } });
    fireEvent.click(screen.getByRole("button", { name: "Record transition" }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update.mock.calls[0]?.[0]).toEqual({
      incidentId: "incident_1",
      ownerId: "admin_next",
      reason: "Assign the active incident commander",
      idempotencyKey: expect.stringMatching(/^incident_/),
    });
    fireEvent.click(screen.getByRole("button", { name: "Load older timeline" }));
    expect(mocks.loadMore).toHaveBeenCalledWith(20);
  });
});
