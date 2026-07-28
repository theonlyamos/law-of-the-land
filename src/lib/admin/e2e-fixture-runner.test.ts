import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bootstrapAdminFixtures,
  cleanupAdminFixtures,
  resolveAdminE2ETarget,
  type FixtureManifest,
} from "../../../e2e/admin/fixture-runner";
import { assertIsolatedWebServerEnvironment, buildWebServerEnvironment } from "../../../e2e/admin/web-server-environment.mjs";
import playwrightConfig from "../../../playwright.config";

const safeEnvironment = {
  ADMIN_E2E_FIXTURE_MODE: "true",
  ADMIN_E2E_TARGET_ENV: "test",
  ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e",
  ADMIN_E2E_PROVIDER_STUB_MODE: "true",
  ADMIN_E2E_CONVEX_URL: "http://127.0.0.1:3210",
  ADMIN_E2E_CONVEX_SITE_URL: "http://127.0.0.1:3211",
  ADMIN_E2E_FIXTURE_SECRET: "fixture-secret-that-is-at-least-32-chars",
  ADMIN_E2E_BETTER_AUTH_SECRET: "better-auth-secret-at-least-32-characters",
  ADMIN_E2E_ACCOUNT_PASSWORD: "local-e2e-password-123",
} satisfies Record<string, string | undefined>;

describe("admin E2E target guard", () => {
  it("accepts only an explicitly enabled isolated localhost target", () => {
    expect(resolveAdminE2ETarget(safeEnvironment)).toMatchObject({
      environment: "test",
      convexUrl: "http://127.0.0.1:3210",
      convexSiteUrl: "http://127.0.0.1:3211",
    });
  });

  it.each([
    [{ ...safeEnvironment, ADMIN_E2E_FIXTURE_MODE: "false" }, /fixture mode/i],
    [{ ...safeEnvironment, ADMIN_E2E_TARGET_ENV: "production" }, /target environment/i],
    [{ ...safeEnvironment, ADMIN_E2E_ISOLATED_TARGET_MARKER: "dev" }, /isolated target marker/i],
    [{ ...safeEnvironment, ADMIN_E2E_CONVEX_URL: undefined }, /ADMIN_E2E_CONVEX_URL/],
    [{ ...safeEnvironment, ADMIN_E2E_CONVEX_SITE_URL: undefined }, /ADMIN_E2E_CONVEX_SITE_URL/],
    [{ ...safeEnvironment, ADMIN_E2E_FIXTURE_SECRET: "short" }, /at least 32 characters/i],
    [{ ...safeEnvironment, CONVEX_DEPLOYMENT: "prod:live-law" }, /production Convex deployment/i],
    [{ ...safeEnvironment, ADMIN_E2E_CONVEX_URL: "https://law-production.convex.cloud", ADMIN_E2E_CONVEX_SITE_URL: "https://law-production.convex.site" }, /production-looking/i],
    [{ ...safeEnvironment, ADMIN_E2E_CONVEX_URL: "https://first-preview.convex.cloud", ADMIN_E2E_CONVEX_SITE_URL: "https://other-preview.convex.site", ADMIN_E2E_TARGET_ENV: "preview" }, /same isolated deployment/i],
  ])("rejects an unsafe target without making requests", (environment, message) => {
    expect(() => resolveAdminE2ETarget(environment)).toThrow(message);
  });

  it("never falls back to inherited application URLs", () => {
    expect(() => resolveAdminE2ETarget({
      ...safeEnvironment,
      ADMIN_E2E_CONVEX_URL: undefined,
      ADMIN_E2E_CONVEX_SITE_URL: undefined,
      NEXT_PUBLIC_CONVEX_URL: "https://inherited-live.convex.cloud",
      NEXT_PUBLIC_CONVEX_SITE_URL: "https://inherited-live.convex.site",
    })).toThrow(/ADMIN_E2E_CONVEX_URL/);
  });
});

describe("admin E2E fixture lifecycle", () => {
  it("bootstraps with authorization, signs cookies, and writes a private manifest", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const manifestPath = join(tmpdir(), `admin-e2e-runner-${crypto.randomUUID()}.json`);
    const request = async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (init.method === "DELETE") {
        return new Response(JSON.stringify({ tag: "e2e_runnerfixture1", deleted: 12 }), { status: 200 });
      }
      return new Response(JSON.stringify({
        tag: "e2e_runnerfixture1",
        providerTransport: "stub",
        sessions: {
          super_admin: { userId: "super", sessionToken: "raw-super-token" },
          content_manager: { userId: "manager", sessionToken: "raw-manager-token" },
          content_reviewer: { userId: "reviewer", sessionToken: "raw-reviewer-token" },
          support_agent: { userId: "support", sessionToken: "raw-support-token" },
          billing_manager: { userId: "billing", sessionToken: "raw-billing-token" },
          auditor: { userId: "auditor", sessionToken: "raw-auditor-token" },
        },
        variants: {
          normal: { userId: "normal", sessionToken: "raw-normal-token" },
          noTwoFactor: { userId: "no-2fa", sessionToken: "raw-no-2fa-token" },
          unassured: { userId: "unassured", sessionToken: "raw-unassured-token" },
        },
        records: { callbackToken: "gx_callback" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const manifest = await bootstrapAdminFixtures({
      environment: safeEnvironment,
      fixtureTag: "e2e_runnerfixture1",
      manifestPath,
      request,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:3211/admin/e2e-fixtures/bootstrap",
      init: { method: "POST", headers: { authorization: "Bearer fixture-secret-that-is-at-least-32-chars", "content-type": "application/json" }, body: '{"tag":"e2e_runnerfixture1"}' },
    });
    expect(manifest.sessions.super_admin).toMatch(/^better-auth\.session_token=raw-super-token\.[A-Za-z0-9+/]+=*$/);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(manifest);
    if (process.platform !== "win32") expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
    await cleanupAdminFixtures({ environment: safeEnvironment, manifestPath, request });
  });

  it("cleans up the exact manifest tag and retains a private recovery manifest when cleanup fails", async () => {
    const manifestPath = join(tmpdir(), `admin-e2e-runner-${crypto.randomUUID()}.json`);
    const manifest: FixtureManifest = {
      version: 1,
      tag: "e2e_exactfixture1",
      convexUrl: "http://127.0.0.1:3210",
      convexSiteUrl: "http://127.0.0.1:3211",
      sessions: { super_admin: "better-auth.session_token=signed" },
      variants: {
        normal: { userId: "normal", cookie: "better-auth.session_token=normal.signed" },
        noTwoFactor: { userId: "no-2fa", cookie: "better-auth.session_token=no2fa.signed" },
        unassured: { userId: "unassured", cookie: "better-auth.session_token=unassured.signed" },
      },
      records: {},
    };
    const setupRequest = async () => new Response(JSON.stringify({
      tag: manifest.tag,
      providerTransport: "stub",
      sessions: {
        super_admin: { userId: "super", sessionToken: "a" }, content_manager: { userId: "manager", sessionToken: "b" },
        content_reviewer: { userId: "reviewer", sessionToken: "c" }, support_agent: { userId: "support", sessionToken: "d" },
        billing_manager: { userId: "billing", sessionToken: "e" }, auditor: { userId: "auditor", sessionToken: "f" },
      },
      variants: {
        normal: { userId: "normal", sessionToken: "normal-token" },
        noTwoFactor: { userId: "no-2fa", sessionToken: "no2fa-token" },
        unassured: { userId: "unassured", sessionToken: "unassured-token" },
      }, records: {},
    }), { status: 200 });
    await bootstrapAdminFixtures({ environment: safeEnvironment, fixtureTag: manifest.tag, manifestPath, request: setupRequest });
    let cleanupBody = "";

    await expect(cleanupAdminFixtures({
      environment: safeEnvironment,
      manifestPath,
      request: async (_url, init) => {
        cleanupBody = String(init.body);
        return new Response("cleanup unavailable", { status: 503 });
      },
    })).rejects.toThrow(/cleanup failed/i);

    expect(cleanupBody).toBe('{"tag":"e2e_exactfixture1"}');
    await expect(readFile(manifestPath, "utf8")).resolves.toContain(manifest.tag);
    await cleanupAdminFixtures({ environment: safeEnvironment, manifestPath, request: async () => new Response(JSON.stringify({ tag: manifest.tag, deleted: 0 }), { status: 200 }) });
  });
});

describe("Playwright web server environment", () => {
  it("wires the guarded lifecycle and scrubbed server launcher", () => {
    expect(playwrightConfig.globalSetup).toBe("./e2e/admin/global-setup.ts");
    expect(playwrightConfig.globalTeardown).toBe("./e2e/admin/global-teardown.ts");
    expect(playwrightConfig.webServer).toMatchObject({
      command: "node ./e2e/admin/start-web-server.mjs",
      reuseExistingServer: false,
    });
  });

  it("forwards only process infrastructure and the explicit public E2E target", () => {
    const environment = buildWebServerEnvironment({
      PATH: "tools", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp",
      ADMIN_E2E_CONVEX_URL: "https://safe-preview.convex.cloud",
      ADMIN_E2E_CONVEX_SITE_URL: "https://safe-preview.convex.site",
      ADMIN_E2E_FIXTURE_SECRET: "must-not-leak",
      ADMIN_E2E_BETTER_AUTH_SECRET: "must-not-leak",
      NEXT_PUBLIC_CONVEX_URL: "https://inherited-live.convex.cloud",
      GROUNDX_API_KEY: "must-not-leak",
    });

    expect(environment).toMatchObject({
      PATH: "tools", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp",
      NEXT_PUBLIC_CONVEX_URL: "https://safe-preview.convex.cloud",
      NEXT_PUBLIC_CONVEX_SITE_URL: "https://safe-preview.convex.site",
    });
    expect(environment).not.toHaveProperty("ADMIN_E2E_FIXTURE_SECRET");
    expect(environment).not.toHaveProperty("ADMIN_E2E_BETTER_AUTH_SECRET");
    expect(environment).not.toHaveProperty("GROUNDX_API_KEY");
    expect(Object.values(environment)).not.toContain("https://inherited-live.convex.cloud");
  });

  it("refuses to start a browser server until the explicit isolated target is complete and safe", () => {
    expect(() => assertIsolatedWebServerEnvironment({})).toThrow(/ADMIN_E2E_FIXTURE_MODE=true/);
    expect(() => assertIsolatedWebServerEnvironment({
      ...safeEnvironment,
      ADMIN_E2E_CONVEX_URL: "https://law-production.convex.cloud",
      ADMIN_E2E_CONVEX_SITE_URL: "https://law-production.convex.site",
    })).toThrow(/production-looking/i);
    expect(() => assertIsolatedWebServerEnvironment(safeEnvironment)).not.toThrow();
  });
});
