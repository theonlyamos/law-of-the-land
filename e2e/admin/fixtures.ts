import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { buildBrowserEnvironment } from "./web-server-environment.mjs";

export const FIXTURE_TAG = "admin-e2e-v1";

export const ROLE_FIXTURES = [
  { role: "super_admin", assured: true, twoFactorEnabled: true },
  { role: "content_manager", assured: true, twoFactorEnabled: true },
  { role: "content_reviewer", assured: true, twoFactorEnabled: true },
  { role: "support_agent", assured: true, twoFactorEnabled: true },
  { role: "billing_manager", assured: true, twoFactorEnabled: true },
  { role: "auditor", assured: true, twoFactorEnabled: true },
  { role: "user", assured: false, twoFactorEnabled: false },
  { role: "super_admin", assured: false, twoFactorEnabled: true },
  { role: "super_admin", assured: true, twoFactorEnabled: false },
] as const;

export const RESOURCE_FIXTURES = {
  stagingBucketId: `${FIXTURE_TAG}-staging`,
  productionBucketId: `${FIXTURE_TAG}-production`,
  callbackProcessId: `${FIXTURE_TAG}-callback`,
  chatExternalId: `${FIXTURE_TAG}-chat`,
  usageUserId: `${FIXTURE_TAG}-usage`,
  jobTargetId: `${FIXTURE_TAG}-job`,
} as const;

type FixedAdminRole = Exclude<(typeof ROLE_FIXTURES)[number]["role"], "user">;

export type BrowserFixtureManifest = {
  tag: string;
  convexUrl: string;
  convexSiteUrl: string;
  sessions: Record<FixedAdminRole, string>;
  variants: Record<"normal" | "noTwoFactor" | "unassured", { userId: string; cookie: string }>;
  jurisdictionUsers: Record<"member" | "formerMember", { userId: string; cookie: string }>;
  records: {
    chatId: string; resourceId: string; publishedVersionId: string; reviewVersionId: string;
    separationVersionId: string; conversationGrantId: string; jurisdictionId: string; userId: string;
    stagingBucketId: string; productionBucketId: string; callbackToken: string; callbackJobId: string;
    usageUserId: string; jurisdictionCountryId: string; jurisdictionTownId: string;
    publicOrganizationJurisdictionId: string; jurisdictionMemberOnlyId: string;
    jurisdictionMemberId: string; jurisdictionFormerMemberId: string;
  };
};

export async function loadBrowserFixtureManifest(): Promise<BrowserFixtureManifest> {
  const manifestPath = process.env.ADMIN_E2E_SESSION_MANIFEST;
  if (!manifestPath) throw new Error("Guarded admin E2E global setup did not publish a session manifest.");
  return JSON.parse(await readFile(manifestPath, "utf8")) as BrowserFixtureManifest;
}

export async function controlBrowserFixtures(
  fixture: BrowserFixtureManifest,
  operation: "arm_provider_outcome" | "expire_conversation_grant" | "run_retention" | "read_state" | "prepare_matrix_operation" | "read_matrix_operation" | "deactivate_jurisdiction_member" | "set_unified_jurisdictions_flag",
  input: string
    | { path: string; role: FixedAdminRole; key: string; payload?: { args: Record<string, unknown>; result: unknown } }
    | { versionId: string; publicationOperation: "publish" | "rollback" | "unpublish"; providerOutcome: "succeeded" | "failed" }
    | { membershipId: string }
    | { enabled: boolean } = "",
) {
  const secret = process.env.ADMIN_E2E_FIXTURE_SECRET;
  if (!secret) throw new Error("ADMIN_E2E_FIXTURE_SECRET is required for guarded fixture control.");
  const response = await fetch(`${fixture.convexSiteUrl}/admin/e2e-fixtures/control`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ tag: fixture.tag, operation, ...(typeof input === "string" ? (input ? { versionId: input } : {}) : input) }),
  });
  if (!response.ok) throw new Error(`Guarded fixture control failed (${response.status}).`);
  const result = await response.json() as {
    path?: string;
    role?: FixedAdminRole;
    args?: Record<string, unknown>;
    success?: string;
    terminal?: boolean;
    state?: Record<string, unknown>;
    armed?: boolean;
    outcome?: "succeeded" | "failed";
    operation?: "publish" | "rollback" | "unpublish";
    membershipId?: string;
    active?: boolean;
    enabled?: boolean;
    cleanupConflict?: boolean;
    activeVersionId: string | null;
    versions: Array<{ id: string; versionNumber: number; status: string; failureSummary: string | null }>;
    publicationJob: { id: string; status: string; processId: string | null; lastErrorKind: string | null } | null;
    grantActive: boolean;
    retention: { deletedTotal: number; lastSuccessfulAt: number | null };
    callbackJob: null | { status: string; payload: string; retentionRedactedAt: number | null };
  };
  if (result.cleanupConflict === true) {
    throw new Error("Guarded fixture control reported an ownership conflict; recovery cleanup remains required.");
  }
  return result;
}

export async function roleCookie(role: FixedAdminRole) {
  const cookie = (await loadBrowserFixtureManifest()).sessions[role];
  if (!cookie) throw new Error(`Guarded fixture manifest is missing the ${role} assured-session cookie.`);
  return cookie;
}

export async function installSessionCookie(context: BrowserContext, cookie: string) {
  const separator = cookie.indexOf("=");
  if (separator < 1) throw new Error("Fixture cookie must use name=value format.");
  await context.clearCookies();
  await context.addCookies([{
    name: cookie.slice(0, separator),
    value: cookie.slice(separator + 1).split(";", 1)[0],
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  }]);
}

export async function openAuthenticatedRolePage(
  context: BrowserContext,
  page: Page,
  role: FixedAdminRole,
  pathname: string,
  heading: string,
) {
  const cookie = await roleCookie(role);
  await installSessionCookie(context, cookie);
  await page.goto(pathname);
  await expect(page).toHaveURL(new RegExp(`${pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Administration" })).toBeVisible();
}

type AcceptanceSlice = {
  convex: readonly string[];
  ui?: readonly string[];
  evidence: readonly RegExp[];
};

export function buildAcceptanceSliceEnvironment(
  parentEnvironment: Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
  return {
    ...buildBrowserEnvironment(parentEnvironment),
    NODE_ENV: "test",
    ADMIN_PANEL_ENABLED: "true",
    ADMIN_ENVIRONMENT: "test",
    BILLING_ENABLED: "true",
  };
}

/**
 * Runs production Convex functions against convex-test's process-isolated
 * database. Every worker gets a fresh database and component; process exit is
 * the cleanup boundary, so persistent or non-fixture records cannot be touched.
 * External provider calls are replaced at the typed adapter boundary by the
 * production integration tests selected below.
 */
export async function runAcceptanceSlice(
  slice: AcceptanceSlice,
  testInfo: TestInfo,
) {
  expect(ROLE_FIXTURES.map((fixture) => fixture.role)).toEqual([
    "super_admin",
    "content_manager",
    "content_reviewer",
    "support_agent",
    "billing_manager",
    "auditor",
    "user",
    "super_admin",
    "super_admin",
  ]);
  expect(RESOURCE_FIXTURES.stagingBucketId).not.toBe(
    RESOURCE_FIXTURES.productionBucketId,
  );

  const files = [...slice.convex, ...(slice.ui ?? [])];
  const vitest = path.resolve("node_modules/vitest/vitest.mjs");
  const result = spawnSync(
    process.execPath,
    [vitest, "run", "--reporter=verbose", ...files],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: buildAcceptanceSliceEnvironment(),
      timeout: 110_000,
    },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  await testInfo.attach("acceptance-output", {
    body: output,
    contentType: "text/plain",
  });

  expect(result.error, output).toBeUndefined();
  expect(result.status, output).toBe(0);
  expect(output, "Vitest must not silently skip an acceptance journey").not.toMatch(
    /\b(skipped|todo)\b/i,
  );
  for (const evidence of slice.evidence) expect(output).toMatch(evidence);
}
