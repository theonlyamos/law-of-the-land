import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AdminOverview } from "./admin-overview";
import { AdminPermissionProvider } from "./permission-boundary";

afterEach(cleanup);

describe("admin overview", () => {
  it("explains unavailable aggregates and empty operational queues", () => {
    render(
      <AdminPermissionProvider
        permissions={["operations:read", "document:review", "audit:read_masked"]}
      >
        <AdminOverview
          overview={{
            counters: [
              {
                key: "active_users",
                label: "Active users",
                value: null,
                freshness: "awaiting_aggregate",
              },
            ],
            failedJobs: [],
            reviewItems: [],
            highRiskEvents: [],
          }}
        />
      </AdminPermissionProvider>,
    );

    expect(screen.getByRole("heading", { name: "System overview" })).toBeVisible();
    expect(screen.getByText("Aggregate pending")).toBeVisible();
    expect(screen.getByText("No failed jobs require attention.")).toBeVisible();
    expect(screen.getByText("Review queue is clear.")).toBeVisible();
    expect(screen.getByText("No high-risk actions recorded.")).toBeVisible();
  });
});
