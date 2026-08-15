import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { resolveE2EProviderIsolation } from "./e2eProviderIsolation";

const DEDICATED_E2E_KEYS = [
  "ADMIN_E2E_FIXTURE_MODE",
  "ADMIN_E2E_TARGET_ENV",
  "ADMIN_E2E_ISOLATED_TARGET_MARKER",
  "ADMIN_E2E_PROVIDER_STUB_MODE",
  "ADMIN_E2E_CONVEX_URL",
  "ADMIN_E2E_CONVEX_SITE_URL",
  "ADMIN_E2E_APPROVED_COMMIT_SHA",
  "ADMIN_E2E_LOCAL_HEAD_SHA",
  "ADMIN_E2E_DEPLOYED_COMMIT_SHA",
  "ADMIN_E2E_PROVIDER_OBSERVATION_SECRET",
  "ADMIN_E2E_FIXTURE_SECRET",
  "ADMIN_E2E_BETTER_AUTH_SECRET",
  "ADMIN_E2E_ACCOUNT_PASSWORD",
  "ADMIN_E2E_FIXTURE_TAG",
  "ADMIN_E2E_ROLE_SESSIONS_JSON",
  "ADMIN_E2E_SESSION_MANIFEST",
  "ADMIN_E2E_PERFORMANCE_CALIBRATION_FILE",
] as const;

function nonEnumerableEnvironment(
  values: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(environment, key, { value });
  }
  return environment;
}

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

  it("selects deterministic stubs from a non-enumerable complete E2E environment", () => {
    const environment = nonEnumerableEnvironment({
      ADMIN_E2E_FIXTURE_MODE: "true",
      ADMIN_E2E_TARGET_ENV: "preview",
      ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e",
      ADMIN_E2E_PROVIDER_STUB_MODE: "true",
    });
    expect(Object.keys(environment)).toEqual([]);
    expect(resolveE2EProviderIsolation(environment)).toBe("stub");
  });

  it.each(DEDICATED_E2E_KEYS)("fails closed for lone non-enumerable E2E key %s", (key) => {
    const environment = nonEnumerableEnvironment({ [key]: "present" });
    expect(Object.keys(environment)).toEqual([]);
    expect(() => resolveE2EProviderIsolation(environment)).toThrowError(
      new ConvexError("E2E_PROVIDER_ISOLATION_MISCONFIGURED"),
    );
  });
});
