import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, type BrowserContext, type Page, type TestInfo } from "@playwright/test";

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

function roleSessionCookies(): Partial<Record<FixedAdminRole, string>> {
  const raw = process.env.ADMIN_E2E_ROLE_SESSIONS_JSON;
  if (!raw) {
    throw new Error(
      "Authenticated admin browser acceptance requires ADMIN_E2E_ROLE_SESSIONS_JSON: a JSON object mapping every fixed role to a locally pre-provisioned assured Better Auth cookie (name=value). A non-production fixture bootstrap was not available, so this gate fails closed instead of skipping.",
    );
  }
  try {
    return JSON.parse(raw) as Partial<Record<FixedAdminRole, string>>;
  } catch {
    throw new Error("ADMIN_E2E_ROLE_SESSIONS_JSON must be valid JSON.");
  }
}

export async function openAuthenticatedRolePage(
  context: BrowserContext,
  page: Page,
  role: FixedAdminRole,
  pathname: string,
  heading: string,
) {
  const cookie = roleSessionCookies()[role];
  if (!cookie) {
    throw new Error(
      `ADMIN_E2E_ROLE_SESSIONS_JSON is missing the ${role} assured-session cookie.`,
    );
  }
  const separator = cookie.indexOf("=");
  if (separator < 1) throw new Error(`${role} fixture cookie must use name=value format.`);
  await context.clearCookies();
  await context.addCookies([{
    name: cookie.slice(0, separator),
    value: cookie.slice(separator + 1).split(";", 1)[0],
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  }]);
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
      env: {
        ...process.env,
        ADMIN_PANEL_ENABLED: "true",
        ADMIN_ENVIRONMENT: "test",
        BILLING_ENABLED: "true",
        ADMIN_E2E_FIXTURE_TAG: FIXTURE_TAG,
      },
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
