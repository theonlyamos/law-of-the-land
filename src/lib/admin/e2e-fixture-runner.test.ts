import { execFileSync } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  bootstrapAdminFixtures,
  cleanupAdminFixtures,
  resolveAdminE2ETarget,
  type FixtureManifest,
} from "../../../e2e/admin/fixture-runner";
import { assertIsolatedWebServerEnvironment, buildBrowserEnvironment, buildWebServerEnvironment } from "../../../e2e/admin/web-server-environment.mjs";
import { clearAdminE2EParentEnvironment } from "../../../e2e/admin/global-teardown";

let playwrightConfig: (typeof import("../../../playwright.config"))["default"];
let initializeAdminE2EProviderIsolation: (typeof import("../../../playwright.config"))["initializeAdminE2EProviderIsolation"];

const approvedCommitSha = "74a989459da6b197013222f0bb5c118eed994d64";
const observationSecret = Buffer.alloc(32, 7).toString("base64url");

const safeEnvironment = {
  ADMIN_E2E_FIXTURE_MODE: "true",
  ADMIN_E2E_TARGET_ENV: "test",
  ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e",
  ADMIN_E2E_PROVIDER_STUB_MODE: "true",
  ADMIN_E2E_CONVEX_URL: "http://127.0.0.1:3210",
  ADMIN_E2E_CONVEX_SITE_URL: "http://127.0.0.1:3211",
  ADMIN_E2E_APPROVED_COMMIT_SHA: approvedCommitSha,
  ADMIN_E2E_LOCAL_HEAD_SHA: approvedCommitSha,
  ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: observationSecret,
  ADMIN_E2E_FIXTURE_SECRET: "fixture-secret-that-is-at-least-32-chars",
  ADMIN_E2E_BETTER_AUTH_SECRET: "better-auth-secret-at-least-32-characters",
  ADMIN_E2E_ACCOUNT_PASSWORD: "local-e2e-password-123",
} satisfies Record<string, string | undefined>;

beforeAll(async () => {
  const configModule = await import("../../../playwright.config");
  playwrightConfig = configModule.default;
  initializeAdminE2EProviderIsolation = configModule.initializeAdminE2EProviderIsolation;
});

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
    expect(manifest.state).toBe("ready");
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(manifest);
    expect(JSON.stringify(manifest)).not.toContain(observationSecret);
    if (process.platform !== "win32") expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
    await cleanupAdminFixtures({ environment: safeEnvironment, manifestPath, request });
  });

  it("writes a sufficient provisional recovery manifest before the bootstrap request and retains it on transport failure", async () => {
    const manifestPath = join(tmpdir(), `admin-e2e-runner-${crypto.randomUUID()}.json`);
    let duringRequest: unknown;
    await expect(bootstrapAdminFixtures({
      environment: safeEnvironment,
      fixtureTag: "e2e_failurewindow1",
      manifestPath,
      request: async () => {
        duringRequest = JSON.parse(await readFile(manifestPath, "utf8"));
        return new Response("bootstrap unavailable", { status: 503 });
      },
    })).rejects.toThrow(/bootstrap failed/i);
    expect(duringRequest).toEqual({
      version: 1,
      state: "provisional",
      tag: "e2e_failurewindow1",
      convexUrl: "http://127.0.0.1:3210",
      convexSiteUrl: "http://127.0.0.1:3211",
    });
    expect(JSON.stringify(duringRequest)).not.toContain(observationSecret);
    await expect(readFile(manifestPath, "utf8")).resolves.toContain('"state":"provisional"');
    await cleanupAdminFixtures({ environment: safeEnvironment, manifestPath, request: async () => new Response(JSON.stringify({ tag: "e2e_failurewindow1", deleted: 0 }), { status: 200 }) });
  });

  it("retains the provisional recovery manifest when a successful response fails validation", async () => {
    const manifestPath = join(tmpdir(), `admin-e2e-runner-${crypto.randomUUID()}.json`);
    await expect(bootstrapAdminFixtures({
      environment: safeEnvironment,
      fixtureTag: "e2e_validationwindow1",
      manifestPath,
      request: async () => new Response(JSON.stringify({ tag: "e2e_validationwindow1", providerTransport: "stub", sessions: {}, variants: {}, records: {} }), { status: 200 }),
    })).rejects.toThrow(/omitted the super_admin session token/i);
    await expect(readFile(manifestPath, "utf8")).resolves.toContain('"state":"provisional"');
    await rm(manifestPath, { force: true });
  });

  it("cleans up the exact manifest tag and retains a private recovery manifest when cleanup fails", async () => {
    const manifestPath = join(tmpdir(), `admin-e2e-runner-${crypto.randomUUID()}.json`);
    const manifest: FixtureManifest = {
      version: 1,
      state: "ready",
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
  it("replaces inherited parent-generated values even when VITEST is inherited", async () => {
    const expectedLocalHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const previous = {
      VITEST: process.env.VITEST,
      approved: process.env.ADMIN_E2E_APPROVED_COMMIT_SHA,
      local: process.env.ADMIN_E2E_LOCAL_HEAD_SHA,
      secret: process.env.ADMIN_E2E_PROVIDER_OBSERVATION_SECRET,
    };
    try {
      process.env.VITEST = "true";
      delete process.env.ADMIN_E2E_APPROVED_COMMIT_SHA;
      process.env.ADMIN_E2E_LOCAL_HEAD_SHA = "f".repeat(40);
      process.env.ADMIN_E2E_PROVIDER_OBSERVATION_SECRET = "inherited-secret";
      vi.resetModules();

      await import("../../../playwright.config");

      expect(process.env.ADMIN_E2E_LOCAL_HEAD_SHA).toBe(expectedLocalHead);
      expect(process.env.ADMIN_E2E_PROVIDER_OBSERVATION_SECRET).not.toBe("inherited-secret");
      expect(Buffer.from(process.env.ADMIN_E2E_PROVIDER_OBSERVATION_SECRET ?? "", "base64url")).toHaveLength(32);
    } finally {
      for (const [key, value] of [
        ["VITEST", previous.VITEST],
        ["ADMIN_E2E_APPROVED_COMMIT_SHA", previous.approved],
        ["ADMIN_E2E_LOCAL_HEAD_SHA", previous.local],
        ["ADMIN_E2E_PROVIDER_OBSERVATION_SECRET", previous.secret],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("derives local HEAD without a shell and replaces inherited parent-generated values", () => {
    const environment: Record<string, string | undefined> = {
      ADMIN_E2E_APPROVED_COMMIT_SHA: approvedCommitSha,
      ADMIN_E2E_LOCAL_HEAD_SHA: "f".repeat(40),
      ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: "inherited-secret",
    };
    const execFile = vi.fn(() => `${approvedCommitSha}\n`);
    const random = vi.fn(() => Buffer.alloc(32, 9));

    initializeAdminE2EProviderIsolation(environment, {
      execFileSync: execFile,
      randomBytes: random,
    });

    expect(execFile).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
    expect(random).toHaveBeenCalledWith(32);
    expect(environment.ADMIN_E2E_LOCAL_HEAD_SHA).toBe(approvedCommitSha);
    expect(environment.ADMIN_E2E_PROVIDER_OBSERVATION_SECRET).toBe(
      Buffer.alloc(32, 9).toString("base64url"),
    );
    expect(JSON.stringify(environment)).not.toContain("inherited-secret");
  });

  it("replaces both inherited values before rejecting an approved/local commit mismatch", () => {
    const environment: Record<string, string | undefined> = {
      ADMIN_E2E_APPROVED_COMMIT_SHA: "a".repeat(40),
      ADMIN_E2E_LOCAL_HEAD_SHA: "f".repeat(40),
      ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: "inherited-secret",
    };
    const random = vi.fn(() => Buffer.alloc(32, 9));

    expect(() => initializeAdminE2EProviderIsolation(environment, {
      execFileSync: vi.fn(() => `${approvedCommitSha}\n`),
      randomBytes: random,
    })).toThrow("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
    expect(random).toHaveBeenCalledWith(32);
    expect(environment.ADMIN_E2E_LOCAL_HEAD_SHA).toBe(approvedCommitSha);
    expect(environment.ADMIN_E2E_PROVIDER_OBSERVATION_SECRET).toBe(
      Buffer.alloc(32, 9).toString("base64url"),
    );
  });

  it("fails closed when the generated observation secret is not canonical 32-byte base64url", () => {
    const environment: Record<string, string | undefined> = {
      ADMIN_E2E_APPROVED_COMMIT_SHA: approvedCommitSha,
      ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: "inherited-secret",
    };

    expect(() => initializeAdminE2EProviderIsolation(environment, {
      execFileSync: vi.fn(() => `${approvedCommitSha}\n`),
      randomBytes: vi.fn(() => ({ toString: () => "not+base64" })),
    })).toThrow("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
    expect(environment.ADMIN_E2E_PROVIDER_OBSERVATION_SECRET).toBe("not+base64");
  });

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
      ADMIN_E2E_FIXTURE_MODE: "true",
      ADMIN_E2E_TARGET_ENV: "preview",
      ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e",
      ADMIN_E2E_PROVIDER_STUB_MODE: "true",
      ADMIN_E2E_APPROVED_COMMIT_SHA: approvedCommitSha,
      ADMIN_E2E_LOCAL_HEAD_SHA: approvedCommitSha,
      ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: observationSecret,
      ADMIN_E2E_FIXTURE_SECRET: "must-not-leak",
      ADMIN_E2E_BETTER_AUTH_SECRET: "must-not-leak",
      NEXT_PUBLIC_CONVEX_URL: "https://inherited-live.convex.cloud",
      GROUNDX_API_KEY: "must-not-leak",
    });

    expect(environment).toMatchObject({
      PATH: "tools", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp",
      NEXT_PUBLIC_CONVEX_URL: "https://safe-preview.convex.cloud",
      NEXT_PUBLIC_CONVEX_SITE_URL: "https://safe-preview.convex.site",
      ADMIN_E2E_FIXTURE_MODE: "true",
      ADMIN_E2E_TARGET_ENV: "preview",
      ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e",
      ADMIN_E2E_PROVIDER_STUB_MODE: "true",
      ADMIN_E2E_CONVEX_URL: "https://safe-preview.convex.cloud",
      ADMIN_E2E_CONVEX_SITE_URL: "https://safe-preview.convex.site",
      ADMIN_E2E_APPROVED_COMMIT_SHA: approvedCommitSha,
      ADMIN_E2E_LOCAL_HEAD_SHA: approvedCommitSha,
      ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: observationSecret,
    });
    expect(environment).not.toHaveProperty("ADMIN_E2E_FIXTURE_SECRET");
    expect(environment).not.toHaveProperty("ADMIN_E2E_BETTER_AUTH_SECRET");
    expect(environment).not.toHaveProperty("GROUNDX_API_KEY");
    expect(Object.values(environment)).not.toContain("https://inherited-live.convex.cloud");
    expect(buildBrowserEnvironment({ ...environment, x_admin_e2e_retrieval_plan_v1: "must-not-leak" }))
      .toEqual({ PATH: "tools", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" });
    expect(JSON.stringify(buildBrowserEnvironment({
      ...environment,
      ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: observationSecret,
      "x-admin-e2e-retrieval-plan-v1": "must-not-enter-artifacts",
    }))).not.toContain("x-admin-e2e-retrieval-plan-v1");
  });

  it("launches Chromium with an explicit allowlist that excludes every parent-held E2E and application secret", () => {
    const environment = buildBrowserEnvironment({
      PATH: "tools", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp",
      ADMIN_E2E_SESSION_MANIFEST: "C:\\private\\manifest.json",
      ADMIN_E2E_FIXTURE_SECRET: "fixture-secret",
      ADMIN_E2E_ACCOUNT_PASSWORD: "account-password",
      ADMIN_E2E_ROLE_SESSIONS_JSON: "role-cookies",
      ADMIN_E2E_BETTER_AUTH_SECRET: "auth-secret",
      ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: observationSecret,
      ADMIN_E2E_LOCAL_HEAD_SHA: approvedCommitSha,
      GROUNDX_API_KEY: "groundx-secret",
      RESEND_API_KEY: "resend-secret",
      BETTER_AUTH_SECRET: "app-auth-secret",
      DATABASE_URL: "database-secret",
    });
    expect(environment).toEqual({ PATH: "tools", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" });
    expect(playwrightConfig.use?.launchOptions?.env).toEqual(buildBrowserEnvironment(process.env));
    for (const secret of ["manifest.json", "fixture-secret", "account-password", "role-cookies", "auth-secret", observationSecret, approvedCommitSha, "groundx-secret", "resend-secret", "app-auth-secret", "database-secret"]) {
      expect(JSON.stringify(environment)).not.toContain(secret);
    }
  });

  it("refuses to start a browser server until the explicit isolated target is complete and safe", () => {
    expect(() => assertIsolatedWebServerEnvironment({})).toThrow(/ADMIN_E2E_FIXTURE_MODE=true/);
    expect(() => assertIsolatedWebServerEnvironment({
      ...safeEnvironment,
      ADMIN_E2E_CONVEX_URL: "https://law-production.convex.cloud",
      ADMIN_E2E_CONVEX_SITE_URL: "https://law-production.convex.site",
    })).toThrow(/production-looking/i);
    expect(() => assertIsolatedWebServerEnvironment({
      ...safeEnvironment,
      CONVEX_DEPLOYMENT: "live:law-of-the-land",
    })).toThrow(/production Convex deployment/i);
    expect(() => assertIsolatedWebServerEnvironment({
      ...safeEnvironment,
      ADMIN_E2E_CONVEX_SITE_URL: "http://127.0.0.2:3211",
    })).toThrow(/matching isolated Convex URLs/i);
    expect(() => assertIsolatedWebServerEnvironment({
      ...safeEnvironment,
      ADMIN_E2E_APPROVED_COMMIT_SHA: ` ${approvedCommitSha}`,
      ADMIN_E2E_LOCAL_HEAD_SHA: ` ${approvedCommitSha}`,
    })).toThrow("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
    expect(() => assertIsolatedWebServerEnvironment(safeEnvironment)).not.toThrow();
  });

  it("does not print the parent secret and clears both parent-generated values", () => {
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values) => output.push(values.join(" ")));
    const warn = vi.spyOn(console, "warn").mockImplementation((...values) => output.push(values.join(" ")));
    const error = vi.spyOn(console, "error").mockImplementation((...values) => output.push(values.join(" ")));
    try {
      assertIsolatedWebServerEnvironment(safeEnvironment);
      buildWebServerEnvironment(safeEnvironment);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
    expect(output.join("\n")).not.toContain(observationSecret);

    const environment: Record<string, string | undefined> = {
      ADMIN_E2E_LOCAL_HEAD_SHA: approvedCommitSha,
      ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: observationSecret,
    };
    clearAdminE2EParentEnvironment(environment);
    expect(environment).toEqual({});
  });
});
