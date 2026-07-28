import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { resolveE2EProviderIsolation } from "./e2eProviderIsolation";

describe("admin E2E provider isolation gate", () => {
  it("leaves the normal production transport path unchanged when no E2E variable exists", () => {
    expect(resolveE2EProviderIsolation({ GROUNDX_API_KEY: "production-key" })).toBe("normal");
  });

  it.each([
    { ADMIN_E2E_FIXTURE_MODE: "true" },
    { ADMIN_E2E_TARGET_ENV: "test" },
    {
      ADMIN_E2E_FIXTURE_MODE: "true",
      ADMIN_E2E_TARGET_ENV: "test",
      ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e",
    },
    {
      ADMIN_E2E_FIXTURE_MODE: "true",
      ADMIN_E2E_TARGET_ENV: "production",
      ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e",
      ADMIN_E2E_PROVIDER_STUB_MODE: "true",
    },
  ])("fails closed for a partial or mismatched E2E environment: %o", (environment) => {
    expect(() => resolveE2EProviderIsolation(environment)).toThrowError(
      new ConvexError("E2E_PROVIDER_ISOLATION_MISCONFIGURED"),
    );
  });

  it("selects deterministic stubs only for the exact isolated fixture environment", () => {
    expect(resolveE2EProviderIsolation({
      ADMIN_E2E_FIXTURE_MODE: "true",
      ADMIN_E2E_TARGET_ENV: "preview",
      ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e",
      ADMIN_E2E_PROVIDER_STUB_MODE: "true",
      ADMIN_E2E_FIXTURE_SECRET: "fixture-only",
    })).toBe("stub");
  });
});
