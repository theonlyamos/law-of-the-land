import { describe, expect, it, vi } from "vitest";
import {
  authorizeAdminPage,
  isAdminAccessDenial,
  loadAdminOverview,
} from "./server";

const denialCodes = [
  "ADMIN_AUTH_REQUIRED",
  "ADMIN_2FA_REQUIRED",
  "ADMIN_FORBIDDEN",
  "ADMIN_DISABLED",
] as const;

describe("server-side admin request sequencing", () => {
  it.each(denialCodes)("recognizes %s for page-level denial handling", (code) => {
    expect(
      isAdminAccessDenial({
        data: { code, message: "Restricted" },
      }),
    ).toBe(true);
  });

  it("does not classify infrastructure failures as access denials", () => {
    expect(isAdminAccessDenial(new Error("connection refused"))).toBe(false);
  });

  it.each(denialCodes)("classifies %s as an expected access denial", async (code) => {
    const denial = Object.assign(new Error("Administrative access denied"), {
      data: { code, message: "Restricted" },
    });
    const fetchQuery = vi.fn().mockRejectedValue(denial);

    await expect(authorizeAdminPage(fetchQuery)).resolves.toEqual({
      status: "denied",
    });
    expect(fetchQuery).toHaveBeenCalledTimes(1);
  });

  it("propagates infrastructure and serialization failures unchanged", async () => {
    const failure = new Error("fetch failed: connection refused");
    const fetchQuery = vi.fn().mockRejectedValue(failure);

    await expect(authorizeAdminPage(fetchQuery)).rejects.toBe(failure);
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
      access: { status: "authorized", currentAdmin },
      overview,
    });
    expect(fetchQuery.mock.invocationCallOrder[0]).toBeLessThan(
      fetchQuery.mock.invocationCallOrder[1],
    );
  });

  it("classifies a structured denial from the overview query without returning content", async () => {
    const currentAdmin = { userId: "admin_1", roles: ["auditor"] };
    const denial = Object.assign(new Error("Administrative access denied"), {
      data: { code: "ADMIN_DISABLED", message: "Restricted" },
    });
    const fetchQuery = vi
      .fn()
      .mockResolvedValueOnce(currentAdmin)
      .mockRejectedValueOnce(denial);

    await expect(loadAdminOverview(fetchQuery)).resolves.toEqual({
      access: { status: "denied" },
      overview: null,
    });
    expect(fetchQuery).toHaveBeenCalledTimes(2);
  });

  it("propagates an infrastructure failure from the overview query unchanged", async () => {
    const currentAdmin = { userId: "admin_1", roles: ["auditor"] };
    const failure = new Error("fetch failed: connection reset");
    const fetchQuery = vi
      .fn()
      .mockResolvedValueOnce(currentAdmin)
      .mockRejectedValueOnce(failure);

    await expect(loadAdminOverview(fetchQuery)).rejects.toBe(failure);
  });

  it("does not request the operations overview for an administrator without that permission", async () => {
    const currentAdmin = { userId: "admin_1", roles: ["support_agent"] };
    const fetchQuery = vi.fn().mockResolvedValue(currentAdmin);

    await expect(loadAdminOverview(fetchQuery)).resolves.toEqual({
      access: { status: "authorized", currentAdmin },
      overview: null,
    });
    expect(fetchQuery).toHaveBeenCalledTimes(1);
  });

  it("does not request overview data after a classified denial", async () => {
    const denial = Object.assign(new Error("Administrative access denied"), {
      data: { code: "ADMIN_FORBIDDEN", message: "Restricted" },
    });
    const fetchQuery = vi
      .fn()
      .mockRejectedValue(denial);

    await expect(loadAdminOverview(fetchQuery)).resolves.toEqual({
      access: { status: "denied" },
      overview: null,
    });
    expect(fetchQuery).toHaveBeenCalledTimes(1);
  });
});
