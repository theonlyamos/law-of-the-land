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
import { controlBrowserFixtures, type BrowserFixtureManifest } from "../../../e2e/admin/fixtures";
import { assertIsolatedWebServerEnvironment, buildBrowserEnvironment, buildWebServerEnvironment } from "../../../e2e/admin/web-server-environment.mjs";
import { clearAdminE2EParentEnvironment } from "../../../e2e/admin/global-teardown";

let playwrightConfig: (typeof import("../../../playwright.config"))["default"];
let initializeAdminE2EProviderIsolation: (typeof import("../../../playwright.config"))["initializeAdminE2EProviderIsolation"];

const approvedCommitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const observationSecret = Buffer.alloc(32, 7).toString("base64url");
const placeClaimSecret = Buffer.alloc(32, 8).toString("base64url");

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
  ADMIN_E2E_PLACE_CLAIM_SECRET: placeClaimSecret,
  ADMIN_E2E_SEARCH_JURISDICTION_SECRET: "search-jurisdiction-secret-that-is-at-least-32-characters",
  ADMIN_E2E_TELEMETRY_INGEST_SECRET: "telemetry-ingest-secret-that-is-at-least-32-characters",
  ADMIN_E2E_FIXTURE_SECRET: "fixture-secret-that-is-at-least-32-chars",
  ADMIN_E2E_BETTER_AUTH_SECRET: "better-auth-secret-at-least-32-characters",
  ADMIN_E2E_ACCOUNT_PASSWORD: "local-e2e-password-123",
  ADMIN_E2E_DEPLOYED_COMMIT_SHA: approvedCommitSha,
  BILLING_ENABLED: "false",
} satisfies Record<string, string | undefined>;

const remoteEnvironment = {
  ...safeEnvironment,
  ADMIN_E2E_TARGET_ENV: "preview",
  ADMIN_E2E_CONVEX_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.cloud",
  ADMIN_E2E_CONVEX_SITE_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.site",
  CONVEX_DEPLOYMENT: "dev:adventurous-hummingbird-244",
} satisfies Record<string, string | undefined>;

function fixtureRecords() {
  return {
    chatId: "chat", resourceId: "resource", publishedVersionId: "published", reviewVersionId: "review",
    separationVersionId: "separation", conversationGrantId: "grant", jurisdictionId: "jurisdiction",
    userId: "normal", stagingBucketId: "910001", productionBucketId: "910002", callbackToken: "gx_callback",
    callbackJobId: "job", usageUserId: "usage", jurisdictionCountryId: "country", jurisdictionTownId: "town",
    publicOrganizationJurisdictionId: "public-org", jurisdictionMemberOnlyId: "member-org",
    jurisdictionMemberId: "membership", jurisdictionFormerMemberId: "former-membership",
  };
}

function bootstrapPayload(tag: string) {
  return {
    tag,
    providerTransport: "stub",
    deployedCommitSha: approvedCommitSha,
    billingDisabled: true,
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
    jurisdictionUsers: {
      member: { userId: "member", sessionToken: "raw-member-token" },
      formerMember: { userId: "former", sessionToken: "raw-former-token" },
    },
    records: fixtureRecords(),
  };
}

function successfulBootstrapRequest(tag: string) {
  return async (url: string, init: RequestInit) => {
    if (url.endsWith("/admin/e2e-fixtures/control")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify(bootstrapPayload(tag)), { status: 200 });
  };
}

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
    [{ ...safeEnvironment, ADMIN_E2E_CONVEX_URL: "http://127.0.0.1:3210/path" }, /origin/i],
    [{ ...safeEnvironment, ADMIN_E2E_CONVEX_URL: " http://127.0.0.1:3210" }, /exact/i],
    [{ ...safeEnvironment, ADMIN_E2E_CONVEX_SITE_URL: "http://127.0.0.1:3211 " }, /exact/i],
    [{ ...safeEnvironment, ADMIN_E2E_FIXTURE_SECRET: "short" }, /at least 32 characters/i],
    [{ ...safeEnvironment, ADMIN_E2E_PLACE_CLAIM_SECRET: undefined }, /ADMIN_E2E_PLACE_CLAIM_SECRET/],
    [{ ...safeEnvironment, ADMIN_E2E_PLACE_CLAIM_SECRET: "not+base64" }, /ADMIN_E2E_PLACE_CLAIM_SECRET/],
    [{ ...safeEnvironment, ADMIN_E2E_SEARCH_JURISDICTION_SECRET: undefined }, /ADMIN_E2E_SEARCH_JURISDICTION_SECRET/],
    [{ ...safeEnvironment, ADMIN_E2E_SEARCH_JURISDICTION_SECRET: "short" }, /ADMIN_E2E_SEARCH_JURISDICTION_SECRET/],
    [{ ...safeEnvironment, ADMIN_E2E_TELEMETRY_INGEST_SECRET: undefined }, /ADMIN_E2E_TELEMETRY_INGEST_SECRET/],
    [{ ...safeEnvironment, ADMIN_E2E_TELEMETRY_INGEST_SECRET: "short" }, /ADMIN_E2E_TELEMETRY_INGEST_SECRET/],
    [{ ...safeEnvironment, CONVEX_DEPLOYMENT: "prod:live-law" }, /production Convex deployment/i],
    [{ ...safeEnvironment, ADMIN_E2E_CONVEX_URL: "https://law-production.convex.cloud", ADMIN_E2E_CONVEX_SITE_URL: "https://law-production.convex.site" }, /production-looking/i],
    [{ ...safeEnvironment, ADMIN_E2E_CONVEX_URL: "https://first-preview.convex.cloud", ADMIN_E2E_CONVEX_SITE_URL: "https://other-preview.convex.site", ADMIN_E2E_TARGET_ENV: "preview" }, /same isolated deployment/i],
    [{ ...remoteEnvironment, ADMIN_E2E_CONVEX_SITE_URL: "https://cautious-penguin-9.eu-west-1.convex.site" }, /same isolated deployment/i],
    [{ ...remoteEnvironment, ADMIN_E2E_CONVEX_SITE_URL: "https://adventurous-hummingbird-244.us-east-1.convex.site" }, /same isolated deployment/i],
    [{ ...remoteEnvironment, ADMIN_E2E_CONVEX_URL: "https://adventurous-hummingbird-244.eu-west-1.extra.convex.cloud", ADMIN_E2E_CONVEX_SITE_URL: "https://adventurous-hummingbird-244.eu-west-1.extra.convex.site" }, /same isolated deployment/i],
    [{ ...remoteEnvironment, ADMIN_E2E_CONVEX_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.cloud:8443" }, /same isolated deployment/i],
    [{ ...remoteEnvironment, ADMIN_E2E_CONVEX_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.cloud:443", ADMIN_E2E_CONVEX_SITE_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.site:443" }, /same isolated deployment/i],
  ])("rejects an unsafe target without making requests", (environment, message) => {
    expect(() => resolveAdminE2ETarget(environment)).toThrow(message);
  });

  it.each([
    ["missing", { ...remoteEnvironment, CONVEX_DEPLOYMENT: undefined }],
    ["malformed", { ...remoteEnvironment, CONVEX_DEPLOYMENT: "preview:safe-preview" }],
    ["mismatched", { ...remoteEnvironment, CONVEX_DEPLOYMENT: "dev:other-preview" }],
    ["opaque and missing", {
      ...remoteEnvironment,
      ADMIN_E2E_CONVEX_URL: "https://opaque-731.eu-west-1.convex.cloud",
      ADMIN_E2E_CONVEX_SITE_URL: "https://opaque-731.eu-west-1.convex.site",
      CONVEX_DEPLOYMENT: undefined,
    }],
  ])("rejects a %s remote deployment binding", (_label, environment) => {
    expect(() => resolveAdminE2ETarget(environment)).toThrow(/CONVEX_DEPLOYMENT/);
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
        return new Response(JSON.stringify({ tag: "e2e_runnerfixture1", deleted: 12, cleanupConflict: false, cleanupPending: false }), { status: 200 });
      }
      if (url.endsWith("/admin/e2e-fixtures/control")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify(bootstrapPayload("e2e_runnerfixture1")), { status: 200, headers: { "content-type": "application/json" } });
    };

    const manifest = await bootstrapAdminFixtures({
      environment: safeEnvironment,
      fixtureTag: "e2e_runnerfixture1",
      manifestPath,
      request,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:3211/admin/e2e-fixtures/bootstrap",
      init: { method: "POST", headers: { authorization: "Bearer fixture-secret-that-is-at-least-32-chars", "content-type": "application/json" }, body: '{"tag":"e2e_runnerfixture1"}' },
    });
    expect(manifest.sessions.super_admin).toMatch(/^better-auth\.session_token=raw-super-token\.[A-Za-z0-9+/]+=*$/);
    expect(manifest.jurisdictionUsers.member).toMatchObject({
      userId: "member",
      cookie: expect.stringMatching(/^better-auth\.session_token=raw-member-token\./),
    });
    expect(requests[1]).toMatchObject({
      url: "http://127.0.0.1:3211/admin/e2e-fixtures/control",
      init: {
        method: "POST",
        headers: { authorization: "Bearer fixture-secret-that-is-at-least-32-chars", "content-type": "application/json" },
      },
    });
    expect(Object.keys(JSON.parse(String(requests[1].init.body))).sort()).toEqual(["operation", "proof", "tag"]);
    expect(JSON.parse(String(requests[1].init.body))).toMatchObject({
      tag: "e2e_runnerfixture1",
      operation: "verify_telemetry_ingest_secret",
      proof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(manifest.state).toBe("ready");
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(manifest);
    expect(JSON.stringify(manifest)).not.toContain(observationSecret);
    expect(JSON.stringify(manifest)).not.toContain(placeClaimSecret);
    expect(JSON.stringify(manifest)).not.toContain(safeEnvironment.ADMIN_E2E_SEARCH_JURISDICTION_SECRET);
    expect(JSON.stringify(manifest)).not.toContain(safeEnvironment.ADMIN_E2E_TELEMETRY_INGEST_SECRET);
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
      version: 2,
      state: "provisional",
      tag: "e2e_failurewindow1",
      targetClass: "test",
      approvedCommitSha,
      convexUrl: "http://127.0.0.1:3210",
      convexSiteUrl: "http://127.0.0.1:3211",
      cleanupEndpoint: "/admin/e2e-fixtures/cleanup",
    });
    expect(JSON.stringify(duringRequest)).not.toContain(observationSecret);
    expect(JSON.stringify(duringRequest)).not.toContain(safeEnvironment.ADMIN_E2E_SEARCH_JURISDICTION_SECRET);
    expect(JSON.stringify(duringRequest)).not.toContain(safeEnvironment.ADMIN_E2E_TELEMETRY_INGEST_SECRET);
    await expect(readFile(manifestPath, "utf8")).resolves.toContain('"state":"provisional"');
    await cleanupAdminFixtures({ environment: safeEnvironment, manifestPath, request: async () => new Response(JSON.stringify({ tag: "e2e_failurewindow1", deleted: 0, cleanupConflict: false, cleanupPending: false }), { status: 200 }) });
  });

  it("rejects a stale approved SHA before writing a provisional manifest", async () => {
    const manifestPath = join(tmpdir(), `admin-e2e-runner-${crypto.randomUUID()}.json`);
    await expect(bootstrapAdminFixtures({
      environment: {
        ...safeEnvironment,
        ADMIN_E2E_APPROVED_COMMIT_SHA: "f".repeat(40),
        ADMIN_E2E_LOCAL_HEAD_SHA: "f".repeat(40),
      },
      fixtureTag: "e2e_stalesha1234",
      manifestPath,
      request: vi.fn(),
    })).rejects.toThrow(/freshly derived local HEAD/i);
    await expect(readFile(manifestPath, "utf8")).rejects.toThrow();
  });

  it("rejects an unsafe tag before writing a provisional manifest", async () => {
    const manifestPath = join(tmpdir(), `admin-e2e-runner-${crypto.randomUUID()}.json`);
    await expect(bootstrapAdminFixtures({
      environment: safeEnvironment,
      fixtureTag: "e2e_bad-tag",
      manifestPath,
      request: vi.fn(),
    })).rejects.toThrow(/fixture tag/i);
    await expect(readFile(manifestPath, "utf8")).rejects.toThrow();
  });

  it("retains the provisional recovery manifest when a successful response fails validation", async () => {
    const manifestPath = join(tmpdir(), `admin-e2e-runner-${crypto.randomUUID()}.json`);
    await expect(bootstrapAdminFixtures({
      environment: safeEnvironment,
      fixtureTag: "e2e_validationwindow1",
      manifestPath,
      request: async (url) => url.endsWith("/admin/e2e-fixtures/control")
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : new Response(JSON.stringify({ tag: "e2e_validationwindow1", providerTransport: "stub", deployedCommitSha: approvedCommitSha, billingDisabled: true, sessions: {}, variants: {}, jurisdictionUsers: {}, records: {} }), { status: 200 }),
    })).rejects.toThrow(/omitted the super_admin session token/i);
    await expect(readFile(manifestPath, "utf8")).resolves.toContain('"state":"provisional"');
    await rm(manifestPath, { force: true });
  });

  it("cleans up the exact manifest tag and retains a private recovery manifest when cleanup fails", async () => {
    const manifestPath = join(tmpdir(), `admin-e2e-runner-${crypto.randomUUID()}.json`);
    const manifest: FixtureManifest = {
      version: 2,
      state: "ready",
      tag: "e2e_exactfixture1",
      targetClass: "test",
      approvedCommitSha,
      convexUrl: "http://127.0.0.1:3210",
      convexSiteUrl: "http://127.0.0.1:3211",
      cleanupEndpoint: "/admin/e2e-fixtures/cleanup",
      sessions: { super_admin: "better-auth.session_token=signed" },
      variants: {
        normal: { userId: "normal", cookie: "better-auth.session_token=normal.signed" },
        noTwoFactor: { userId: "no-2fa", cookie: "better-auth.session_token=no2fa.signed" },
        unassured: { userId: "unassured", cookie: "better-auth.session_token=unassured.signed" },
      },
      jurisdictionUsers: {
        member: { userId: "member", cookie: "better-auth.session_token=member.signed" },
        formerMember: { userId: "former", cookie: "better-auth.session_token=former.signed" },
      },
      records: fixtureRecords(),
    };
    const setupRequest = successfulBootstrapRequest(manifest.tag);
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
    await cleanupAdminFixtures({ environment: safeEnvironment, manifestPath, request: async () => new Response(JSON.stringify({ tag: manifest.tag, deleted: 0, cleanupConflict: false, cleanupPending: false }), { status: 200 }) });
  });

  it("treats a typed cleanup conflict as failure and retains the manifest", async () => {
    const manifestPath = join(tmpdir(), `admin-e2e-runner-${crypto.randomUUID()}.json`);
    const tag = "e2e_cleanupconflict1";
    await bootstrapAdminFixtures({
      environment: safeEnvironment,
      fixtureTag: tag,
      manifestPath,
      request: successfulBootstrapRequest(tag),
    });
    await expect(cleanupAdminFixtures({
      environment: safeEnvironment,
      manifestPath,
      request: async () => new Response(JSON.stringify({ tag, deleted: 0, cleanupConflict: true, cleanupPending: false }), { status: 200 }),
    })).rejects.toThrow(/ownership conflict/i);
    await expect(readFile(manifestPath, "utf8")).resolves.toContain(tag);
    await rm(manifestPath, { force: true });
  });

  it("continues bounded cleanup requests until the target confirms completion", async () => {
    const manifestPath = join(tmpdir(), `admin-e2e-runner-${crypto.randomUUID()}.json`);
    const tag = "e2e_boundedcleanup1";
    await bootstrapAdminFixtures({
      environment: safeEnvironment,
      fixtureTag: tag,
      manifestPath,
      request: successfulBootstrapRequest(tag),
    });
    const responses = [
      { tag, deleted: 95, cleanupConflict: false, cleanupPending: true },
      { tag, deleted: 0, cleanupConflict: false, cleanupPending: false },
    ];
    let requests = 0;

    await cleanupAdminFixtures({
      environment: safeEnvironment,
      manifestPath,
      request: async () => new Response(JSON.stringify(responses[requests++]), { status: 200 }),
    });

    expect(requests).toBe(2);
    await expect(readFile(manifestPath, "utf8")).rejects.toThrow();
  });

  it("requires a target-bound search transport secret and maps it only into the Next child", () => {
    const searchTransportSecret = safeEnvironment.ADMIN_E2E_SEARCH_JURISDICTION_SECRET;
    expect(() => resolveAdminE2ETarget({
      ...safeEnvironment,
      ADMIN_E2E_SEARCH_JURISDICTION_SECRET: undefined,
    })).toThrow(/ADMIN_E2E_SEARCH_JURISDICTION_SECRET/);
    const child = buildWebServerEnvironment({
      ...safeEnvironment,
      ADMIN_E2E_SEARCH_JURISDICTION_SECRET: searchTransportSecret,
    });
    expect(child.SEARCH_JURISDICTION_SECRET).toBe(searchTransportSecret);
    expect(child).not.toHaveProperty("ADMIN_E2E_SEARCH_JURISDICTION_SECRET");
    expect(JSON.stringify(buildBrowserEnvironment({
      ...child,
      ADMIN_E2E_SEARCH_JURISDICTION_SECRET: searchTransportSecret,
    }))).not.toContain(searchTransportSecret);
  });

  it("requires a target-bound telemetry secret and maps it only into the Next child", () => {
    const telemetrySecret = safeEnvironment.ADMIN_E2E_TELEMETRY_INGEST_SECRET;
    expect(() => resolveAdminE2ETarget({
      ...safeEnvironment,
      ADMIN_E2E_TELEMETRY_INGEST_SECRET: undefined,
    })).toThrow(/ADMIN_E2E_TELEMETRY_INGEST_SECRET/);
    const child = buildWebServerEnvironment({
      ...safeEnvironment,
      ADMIN_E2E_TELEMETRY_INGEST_SECRET: telemetrySecret,
    });
    expect(child.TELEMETRY_INGEST_SECRET).toBe(telemetrySecret);
    expect(child).not.toHaveProperty("ADMIN_E2E_TELEMETRY_INGEST_SECRET");
    expect(JSON.stringify(buildBrowserEnvironment({
      ...child,
      ADMIN_E2E_TELEMETRY_INGEST_SECRET: telemetrySecret,
    }))).not.toContain(telemetrySecret);
  });

  it("refuses bootstrap and retains recovery state when target telemetry verification fails", async () => {
    const manifestPath = join(tmpdir(), `admin-e2e-runner-${crypto.randomUUID()}.json`);
    const tag = "e2e_telemetrymismatch1";
    await expect(bootstrapAdminFixtures({
      environment: safeEnvironment,
      fixtureTag: tag,
      manifestPath,
      request: async (url) => url.endsWith("/admin/e2e-fixtures/control")
        ? new Response(JSON.stringify({ error: "Fixture control refused" }), { status: 409 })
        : new Response(JSON.stringify(bootstrapPayload(tag)), { status: 200 }),
    })).rejects.toThrow(/telemetry secret verification failed/i);
    await expect(readFile(manifestPath, "utf8")).resolves.toContain('"state":"provisional"');
    await rm(manifestPath, { force: true });
  });
});

describe("admin E2E place-claim control client", () => {
  it("sends only the route-minted claim and rejects a target verification refusal", async () => {
    const fixture = {
      tag: "e2e_placeclaimrunner1",
      convexUrl: "http://127.0.0.1:3210",
      convexSiteUrl: "http://127.0.0.1:3211",
      sessions: {},
      variants: {},
      jurisdictionUsers: {},
      records: {},
    } as unknown as BrowserFixtureManifest;
    const previousSecret = process.env.ADMIN_E2E_FIXTURE_SECRET;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      new Response(JSON.stringify({ ok: true, place: {
        googlePlaceId: "stub-accra", name: "Accra", formattedAddress: "Accra, Ghana",
        latitude: 5.6037, longitude: -0.187, countryCode: "GH", aliases: ["accra"],
      } }), { status: 200 }),
      new Response(null, { status: 409 }),
    ];
    process.env.ADMIN_E2E_FIXTURE_SECRET = "fixture-secret-that-is-at-least-32-chars";
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected fixture control request.");
      return response;
    });
    try {
      await expect(controlBrowserFixtures(fixture, "verify_place_claim", { claim: "route-minted-claim" }))
        .resolves.toMatchObject({ ok: true, place: { googlePlaceId: "stub-accra" } });
      expect(requests[0]).toMatchObject({
        url: "http://127.0.0.1:3211/admin/e2e-fixtures/control",
        init: { method: "POST", body: '{"tag":"e2e_placeclaimrunner1","operation":"verify_place_claim","claim":"route-minted-claim"}' },
      });
      expect(String(requests[0].init?.body)).not.toContain("superAdminActorId");
      await expect(controlBrowserFixtures(fixture, "verify_place_claim", { claim: "wrong-or-tampered-claim" }))
        .rejects.toThrow("Guarded fixture control failed (409)");
    } finally {
      vi.unstubAllGlobals();
      if (previousSecret === undefined) delete process.env.ADMIN_E2E_FIXTURE_SECRET;
      else process.env.ADMIN_E2E_FIXTURE_SECRET = previousSecret;
    }
  });
});

describe("Playwright web server environment", () => {
  it("replaces only the parent-generated observation secret even when VITEST is inherited", async () => {
    const expectedLocalHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const previous = {
      VITEST: process.env.VITEST,
      approved: process.env.ADMIN_E2E_APPROVED_COMMIT_SHA,
      local: process.env.ADMIN_E2E_LOCAL_HEAD_SHA,
      secret: process.env.ADMIN_E2E_PROVIDER_OBSERVATION_SECRET,
      placeClaim: process.env.ADMIN_E2E_PLACE_CLAIM_SECRET,
    };
    try {
      process.env.VITEST = "true";
      delete process.env.ADMIN_E2E_APPROVED_COMMIT_SHA;
      process.env.ADMIN_E2E_LOCAL_HEAD_SHA = "f".repeat(40);
      process.env.ADMIN_E2E_PROVIDER_OBSERVATION_SECRET = "inherited-secret";
      process.env.ADMIN_E2E_PLACE_CLAIM_SECRET = placeClaimSecret;
      vi.resetModules();

      await import("../../../playwright.config");

      expect(process.env.ADMIN_E2E_LOCAL_HEAD_SHA).toBe(expectedLocalHead);
      expect(process.env.ADMIN_E2E_PROVIDER_OBSERVATION_SECRET).not.toBe("inherited-secret");
      expect(Buffer.from(process.env.ADMIN_E2E_PROVIDER_OBSERVATION_SECRET ?? "", "base64url")).toHaveLength(32);
      expect(process.env.ADMIN_E2E_PLACE_CLAIM_SECRET).toBe(placeClaimSecret);
    } finally {
      for (const [key, value] of [
        ["VITEST", previous.VITEST],
        ["ADMIN_E2E_APPROVED_COMMIT_SHA", previous.approved],
        ["ADMIN_E2E_LOCAL_HEAD_SHA", previous.local],
        ["ADMIN_E2E_PROVIDER_OBSERVATION_SECRET", previous.secret],
        ["ADMIN_E2E_PLACE_CLAIM_SECRET", previous.placeClaim],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("retains the provisional manifest when the deployed commit differs", async () => {
    const manifestPath = join(tmpdir(), `admin-e2e-runner-${crypto.randomUUID()}.json`);
    await expect(bootstrapAdminFixtures({
      environment: safeEnvironment,
      fixtureTag: "e2e_deploysha123",
      manifestPath,
      request: async () => new Response(JSON.stringify({
        tag: "e2e_deploysha123",
        providerTransport: "stub",
        deployedCommitSha: "f".repeat(40),
      }), { status: 200 }),
    })).rejects.toThrow(/deployed commit/i);
    await expect(readFile(manifestPath, "utf8")).resolves.toContain('"state":"provisional"');
    await rm(manifestPath, { force: true });
  });

  it("accepts a remote target only with its exact development deployment binding", () => {
    expect(resolveAdminE2ETarget(remoteEnvironment)).toMatchObject({
      environment: "preview",
      convexUrl: "https://adventurous-hummingbird-244.eu-west-1.convex.cloud",
      convexSiteUrl: "https://adventurous-hummingbird-244.eu-west-1.convex.site",
    });
  });

  it("derives local HEAD without a shell and replaces only the observation secret", () => {
    const environment: Record<string, string | undefined> = {
      ADMIN_E2E_APPROVED_COMMIT_SHA: approvedCommitSha,
      ADMIN_E2E_LOCAL_HEAD_SHA: "f".repeat(40),
      ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: "inherited-secret",
      ADMIN_E2E_PLACE_CLAIM_SECRET: placeClaimSecret,
    };
    const execFile = vi.fn(() => `${approvedCommitSha}\n`);
    const random = vi.fn(() => Buffer.alloc(32, 9));

    initializeAdminE2EProviderIsolation(environment, {
      execFileSync: execFile,
      randomBytes: random,
    });

    expect(execFile).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
    expect(random).toHaveBeenCalledWith(32);
    expect(random).toHaveBeenCalledTimes(1);
    expect(environment.ADMIN_E2E_LOCAL_HEAD_SHA).toBe(approvedCommitSha);
    expect(environment.ADMIN_E2E_PROVIDER_OBSERVATION_SECRET).toBe(
      Buffer.alloc(32, 9).toString("base64url"),
    );
    expect(environment.ADMIN_E2E_PLACE_CLAIM_SECRET).toBe(placeClaimSecret);
    expect(JSON.stringify(environment)).not.toContain("inherited-secret");
  });

  it("replaces both inherited values before rejecting an approved/local commit mismatch", () => {
    const environment: Record<string, string | undefined> = {
      ADMIN_E2E_APPROVED_COMMIT_SHA: "a".repeat(40),
      ADMIN_E2E_LOCAL_HEAD_SHA: "f".repeat(40),
      ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: "inherited-secret",
      ADMIN_E2E_PLACE_CLAIM_SECRET: placeClaimSecret,
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
    expect(environment.ADMIN_E2E_PLACE_CLAIM_SECRET).toBe(placeClaimSecret);
  });

  it("fails closed when the generated observation secret is not canonical 32-byte base64url", () => {
    const environment: Record<string, string | undefined> = {
      ADMIN_E2E_APPROVED_COMMIT_SHA: approvedCommitSha,
      ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: "inherited-secret",
      ADMIN_E2E_PLACE_CLAIM_SECRET: "inherited-place-claim-secret",
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
      ADMIN_E2E_PLACE_CLAIM_SECRET: placeClaimSecret,
      ADMIN_E2E_SEARCH_JURISDICTION_SECRET: "search-jurisdiction-secret-that-is-at-least-32-characters",
      ADMIN_E2E_TELEMETRY_INGEST_SECRET: "telemetry-ingest-secret-that-is-at-least-32-characters",
      CONVEX_DEPLOYMENT: "dev:safe-preview",
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
      PLACE_CLAIM_SECRET: placeClaimSecret,
      SEARCH_JURISDICTION_SECRET: "search-jurisdiction-secret-that-is-at-least-32-characters",
      TELEMETRY_INGEST_SECRET: "telemetry-ingest-secret-that-is-at-least-32-characters",
      CONVEX_DEPLOYMENT: "dev:safe-preview",
    });
    expect(environment).not.toHaveProperty("ADMIN_E2E_FIXTURE_SECRET");
    expect(environment).not.toHaveProperty("ADMIN_E2E_BETTER_AUTH_SECRET");
    expect(environment).not.toHaveProperty("ADMIN_E2E_PLACE_CLAIM_SECRET");
    expect(environment).not.toHaveProperty("ADMIN_E2E_SEARCH_JURISDICTION_SECRET");
    expect(environment).not.toHaveProperty("ADMIN_E2E_TELEMETRY_INGEST_SECRET");
    expect(environment).not.toHaveProperty("GROUNDX_API_KEY");
    expect(Object.values(environment)).not.toContain("https://inherited-live.convex.cloud");
    expect(buildBrowserEnvironment({ ...environment, x_admin_e2e_retrieval_plan_v1: "must-not-leak" }))
      .toEqual({ PATH: "tools", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" });
    expect(JSON.stringify(buildBrowserEnvironment({
      ...environment,
      ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: observationSecret,
      ADMIN_E2E_PLACE_CLAIM_SECRET: placeClaimSecret,
      ADMIN_E2E_SEARCH_JURISDICTION_SECRET: "search-jurisdiction-secret-that-is-at-least-32-characters",
      ADMIN_E2E_TELEMETRY_INGEST_SECRET: "telemetry-ingest-secret-that-is-at-least-32-characters",
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
      ADMIN_E2E_PLACE_CLAIM_SECRET: placeClaimSecret,
      ADMIN_E2E_LOCAL_HEAD_SHA: approvedCommitSha,
      PLACE_CLAIM_SECRET: "inherited-place-claim-secret",
      GROUNDX_API_KEY: "groundx-secret",
      RESEND_API_KEY: "resend-secret",
      BETTER_AUTH_SECRET: "app-auth-secret",
      DATABASE_URL: "database-secret",
    });
    expect(environment).toEqual({ PATH: "tools", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" });
    expect(playwrightConfig.use?.launchOptions?.env).toEqual(buildBrowserEnvironment(process.env));
    for (const secret of ["manifest.json", "fixture-secret", "account-password", "role-cookies", "auth-secret", observationSecret, placeClaimSecret, "search-jurisdiction-secret-that-is-at-least-32-characters", "telemetry-ingest-secret-that-is-at-least-32-characters", approvedCommitSha, "inherited-place-claim-secret", "groundx-secret", "resend-secret", "app-auth-secret", "database-secret"]) {
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
      ...remoteEnvironment,
      CONVEX_DEPLOYMENT: undefined,
    })).toThrow(/CONVEX_DEPLOYMENT/);
    expect(() => assertIsolatedWebServerEnvironment({
      ...remoteEnvironment,
      CONVEX_DEPLOYMENT: "preview:safe-preview",
    })).toThrow(/CONVEX_DEPLOYMENT/);
    expect(() => assertIsolatedWebServerEnvironment({
      ...remoteEnvironment,
      CONVEX_DEPLOYMENT: "dev:other-preview",
    })).toThrow(/CONVEX_DEPLOYMENT/);
    expect(() => assertIsolatedWebServerEnvironment({
      ...remoteEnvironment,
      ADMIN_E2E_CONVEX_SITE_URL: "https://cautious-penguin-9.eu-west-1.convex.site",
    })).toThrow(/matching isolated Convex URLs/i);
    expect(() => assertIsolatedWebServerEnvironment({
      ...remoteEnvironment,
      ADMIN_E2E_CONVEX_SITE_URL: "https://adventurous-hummingbird-244.us-east-1.convex.site",
    })).toThrow(/matching isolated Convex URLs/i);
    expect(() => assertIsolatedWebServerEnvironment({
      ...remoteEnvironment,
      ADMIN_E2E_CONVEX_URL: "https://adventurous-hummingbird-244.eu-west-1.extra.convex.cloud",
      ADMIN_E2E_CONVEX_SITE_URL: "https://adventurous-hummingbird-244.eu-west-1.extra.convex.site",
    })).toThrow(/matching isolated Convex URLs/i);
    expect(() => assertIsolatedWebServerEnvironment({
      ...remoteEnvironment,
      ADMIN_E2E_CONVEX_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.cloud:443",
      ADMIN_E2E_CONVEX_SITE_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.site:443",
    })).toThrow(/matching isolated Convex URLs/i);
    expect(() => assertIsolatedWebServerEnvironment({
      ...remoteEnvironment,
      ADMIN_E2E_CONVEX_URL: "https://opaque-731.eu-west-1.convex.cloud",
      ADMIN_E2E_CONVEX_SITE_URL: "https://opaque-731.eu-west-1.convex.site",
      CONVEX_DEPLOYMENT: undefined,
    })).toThrow(/CONVEX_DEPLOYMENT/);
    expect(() => assertIsolatedWebServerEnvironment({
      ...safeEnvironment,
      ADMIN_E2E_APPROVED_COMMIT_SHA: ` ${approvedCommitSha}`,
      ADMIN_E2E_LOCAL_HEAD_SHA: ` ${approvedCommitSha}`,
    })).toThrow("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
    expect(() => assertIsolatedWebServerEnvironment({
      ...safeEnvironment,
      ADMIN_E2E_PLACE_CLAIM_SECRET: undefined,
    })).toThrow("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
    expect(() => assertIsolatedWebServerEnvironment({
      ...safeEnvironment,
      ADMIN_E2E_PLACE_CLAIM_SECRET: "not+base64",
    })).toThrow("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
    expect(() => assertIsolatedWebServerEnvironment({
      ...safeEnvironment,
      ADMIN_E2E_SEARCH_JURISDICTION_SECRET: undefined,
    })).toThrow("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
    expect(() => assertIsolatedWebServerEnvironment({
      ...safeEnvironment,
      ADMIN_E2E_TELEMETRY_INGEST_SECRET: undefined,
    })).toThrow("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
    expect(() => assertIsolatedWebServerEnvironment({
      ...safeEnvironment,
      ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: Buffer.alloc(33, 7).toString("base64url"),
    })).not.toThrow();
    expect(() => assertIsolatedWebServerEnvironment(remoteEnvironment)).not.toThrow();
    expect(() => assertIsolatedWebServerEnvironment(safeEnvironment)).not.toThrow();
  });

  it("does not print the parent secrets and clears every parent-generated value", () => {
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
    expect(output.join("\n")).not.toContain(placeClaimSecret);
    expect(output.join("\n")).not.toContain(safeEnvironment.ADMIN_E2E_SEARCH_JURISDICTION_SECRET);
    expect(output.join("\n")).not.toContain(safeEnvironment.ADMIN_E2E_TELEMETRY_INGEST_SECRET);

    const environment: Record<string, string | undefined> = {
      ADMIN_E2E_LOCAL_HEAD_SHA: approvedCommitSha,
      ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: observationSecret,
      ADMIN_E2E_PLACE_CLAIM_SECRET: placeClaimSecret,
      ADMIN_E2E_SEARCH_JURISDICTION_SECRET: safeEnvironment.ADMIN_E2E_SEARCH_JURISDICTION_SECRET,
      ADMIN_E2E_TELEMETRY_INGEST_SECRET: safeEnvironment.ADMIN_E2E_TELEMETRY_INGEST_SECRET,
    };
    clearAdminE2EParentEnvironment(environment);
    expect(environment).toEqual({});
  });
});
