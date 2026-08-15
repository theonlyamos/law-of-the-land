import { describe, expect, it } from "vitest";
import { buildAcceptanceSliceEnvironment } from "../../../e2e/admin/fixtures";

const ORCHESTRATION_KEYS = [
  "ADMIN_E2E_FIXTURE_MODE",
  "ADMIN_E2E_TARGET_ENV",
  "ADMIN_E2E_ISOLATED_TARGET_MARKER",
  "ADMIN_E2E_PROVIDER_STUB_MODE",
  "ADMIN_E2E_FIXTURE_SECRET",
  "ADMIN_E2E_SESSION_MANIFEST",
] as const;

const LIVE_TARGET_AND_SECRET_KEYS = [
  "CONVEX_DEPLOYMENT",
  "CONVEX_SITE_URL",
  "NEXT_PUBLIC_CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_SITE_URL",
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "POLAR_ACCESS_TOKEN",
] as const;

describe("admin acceptance slice environment", () => {
  it("does not pass parent E2E orchestration values to the local Vitest child", () => {
    const environment = buildAcceptanceSliceEnvironment({
      PATH: "test-tools",
      ADMIN_E2E_FIXTURE_MODE: "true",
      ADMIN_E2E_TARGET_ENV: "test",
      ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e",
      ADMIN_E2E_PROVIDER_STUB_MODE: "true",
      ADMIN_E2E_FIXTURE_SECRET: "parent-secret",
      ADMIN_E2E_SESSION_MANIFEST: "C:\\private\\manifest.json",
      CONVEX_DEPLOYMENT: "dev:live-target",
      CONVEX_SITE_URL: "https://live-target.convex.site",
      NEXT_PUBLIC_CONVEX_URL: "https://live-target.convex.cloud",
      NEXT_PUBLIC_CONVEX_SITE_URL: "https://live-target.convex.site",
      BETTER_AUTH_SECRET: "live-auth-secret",
      GOOGLE_CLIENT_SECRET: "live-google-secret",
      POLAR_ACCESS_TOKEN: "live-polar-token",
    });
    for (const key of ORCHESTRATION_KEYS) {
      expect(environment).not.toHaveProperty(key);
    }
    for (const key of LIVE_TARGET_AND_SECRET_KEYS) {
      expect(environment).not.toHaveProperty(key);
    }
    expect(environment).not.toHaveProperty("ADMIN_E2E_FIXTURE_TAG");
    expect(environment).toMatchObject({
      PATH: "test-tools",
      NODE_ENV: "test",
      ADMIN_PANEL_ENABLED: "true",
      ADMIN_ENVIRONMENT: "test",
      BILLING_ENABLED: "true",
    });
  });
});
