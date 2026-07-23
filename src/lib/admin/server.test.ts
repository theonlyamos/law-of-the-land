import { describe, expect, it, vi } from "vitest";
import { loadAdminOverview } from "./server";

describe("server-side admin request sequencing", () => {
  it("does not request overview data when the authoritative admin check fails", async () => {
    const fetchQuery = vi.fn().mockRejectedValue(new Error("Admin permission required"));

    await expect(loadAdminOverview(fetchQuery)).rejects.toThrow(
      "Admin permission required",
    );
    expect(fetchQuery).toHaveBeenCalledTimes(1);
  });

  it("loads overview data only after the authoritative admin check succeeds", async () => {
    const currentAdmin = { userId: "admin_1", roles: ["auditor"] };
    const overview = {
      counters: [],
      failedJobs: [],
      reviewItems: [],
      highRiskEvents: [],
    };
    const fetchQuery = vi
      .fn()
      .mockResolvedValueOnce(currentAdmin)
      .mockResolvedValueOnce(overview);

    await expect(loadAdminOverview(fetchQuery)).resolves.toEqual({
      currentAdmin,
      overview,
    });
    expect(fetchQuery.mock.invocationCallOrder[0]).toBeLessThan(
      fetchQuery.mock.invocationCallOrder[1],
    );
  });

  it("does not request the operations overview for an administrator without that permission", async () => {
    const currentAdmin = { userId: "admin_1", roles: ["support_agent"] };
    const fetchQuery = vi.fn().mockResolvedValue(currentAdmin);

    await expect(loadAdminOverview(fetchQuery)).resolves.toEqual({
      currentAdmin,
      overview: null,
    });
    expect(fetchQuery).toHaveBeenCalledTimes(1);
  });
});
