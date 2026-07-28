import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { E2E_PRIVILEGED_FUNCTIONS, E2E_PROTECTED_ROUTES } from "../../convex/admin/e2eAccessMatrix";
import {
  installSessionCookie,
  loadBrowserFixtureManifest,
  openAuthenticatedRolePage,
  roleCookie,
  runAcceptanceSlice,
} from "./fixtures";

const ADMIN_ROLES = ["super_admin", "content_manager", "content_reviewer", "support_agent", "billing_manager", "auditor"] as const;

function runtimeArgs(path: string, fixture: Awaited<ReturnType<typeof loadBrowserFixtureManifest>>, key: string) {
  const records = fixture.records;
  const nonexistentUser = `missing.${fixture.tag}`;
  const reason = "Runtime authorization matrix probe";
  const checklistAnswers = { sourceAuthentic: true, metadataAccurate: true, extractionReviewed: true, citationsVerified: true, evaluationPassed: true };
  const byPath: Record<string, Record<string, unknown>> = {
    "admin/users:assignRoles": { userId: nonexistentUser, roles: [], reason, idempotencyKey: key },
    "admin/users:banUser": { userId: nonexistentUser, reason, confirmation: `BAN ${nonexistentUser}`, idempotencyKey: key },
    "admin/users:resendVerification": { userId: nonexistentUser, reason, idempotencyKey: key },
    "admin/users:revokeSession": { userId: nonexistentUser, sessionId: "missing-session", reason, confirmation: "REVOKE missing-session", idempotencyKey: key },
    "admin/conversations:createAccessGrant": { chatId: records.chatId, purpose: reason },
    "admin/exports:queueConversationExport": { chatId: records.chatId, grantId: records.conversationGrantId, reason, confirmation: `EXPORT ${records.chatId}`, idempotencyKey: key },
    "admin/resources:createResource": { jurisdictionId: records.jurisdictionId, type: "invalid", title: "Runtime probe", issuer: "Fixture", officialCitation: `${fixture.tag}-${key}`, sourceUrl: "https://example.invalid/runtime", topics: [], effectiveDate: "2026-01-01", reason },
    "admin/reviews:approveVersion": { versionId: records.publishedVersionId, checklistAnswers, evaluationRunId: key, reason, idempotencyKey: key },
    "admin/publication:publishVersion": { versionId: records.reviewVersionId, confirmation: `PUBLISH ${records.reviewVersionId}`, reason, idempotencyKey: key },
    "admin/publication:unpublishVersion": { versionId: records.publishedVersionId, confirmation: `UNPUBLISH ${records.publishedVersionId}`, reason, idempotencyKey: key },
    "admin/publication:rollbackVersion": { versionId: records.publishedVersionId, confirmation: `ROLLBACK ${records.publishedVersionId}`, reason, idempotencyKey: key },
    "admin/billing:grantQuotaOverride": { userId: records.userId, limit: 0, startsAt: Date.now(), expiresAt: Date.now() + 10_000, reason, confirmation: "", idempotencyKey: key },
    "admin/jobs:retryJob": { jobId: records.callbackJobId, reason, idempotencyKey: key },
    "admin/operations:createIncident": { title: "x", severity: "low", reason, idempotencyKey: key },
  };
  return byPath[path];
}

test("unauthenticated administration fails closed with an accessible recovery path", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/signin\?redirect=%2Fadmin$/);
  await expect(page.getByRole("heading", { name: "Sign in to your account" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
});

test("fixed roles, Two Factor assurance, navigation, and direct-call denials", async ({}, testInfo) => {
  await runAcceptanceSlice(
    {
      convex: ["convex/admin/permissions.test.ts"],
      ui: ["src/components/admin/admin-shell.test.tsx"],
      evidence: [
        /grants only the fixed role permissions/,
        /rejects an authoritative admin whose Two Factor enrollment is disabled/,
        /rejects an enrolled admin using an unassured/,
        /shows support tools without exposing document administration/,
        /provides a keyboard skip link and a named administration region/,
      ],
    },
    testInfo,
  );
});

test("every fixed role is allowed or denied on every protected route", async ({ context, page }) => {
  for (const role of ADMIN_ROLES) {
    await installSessionCookie(context, roleCookie(role));
    for (const route of E2E_PROTECTED_ROUTES) {
      await page.goto(route.path);
      if ((route.allowed as readonly string[]).includes(role)) {
        await expect(page).toHaveURL(new RegExp(`${route.path}$`));
      } else {
        await expect(page).toHaveURL(/\/admin\/forbidden$/);
      }
    }
  }
});

test("normal, unenrolled, and unassured sessions fail closed at the admin boundary", async ({ context, page }) => {
  const fixture = await loadBrowserFixtureManifest();
  for (const variant of [fixture.variants.normal, fixture.variants.noTwoFactor, fixture.variants.unassured]) {
    await installSessionCookie(context, variant.cookie);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/forbidden$/);
  }
});

test("every fixed role executes every privileged function row against the isolated target", async ({ context }) => {
  const fixture = await loadBrowserFixtureManifest();
  for (const role of ADMIN_ROLES) {
    await installSessionCookie(context, roleCookie(role));
    const tokenResponse = await context.request.get("/api/auth/convex/token");
    expect(tokenResponse.ok(), `${role} must obtain an isolated Convex JWT`).toBe(true);
    const { token } = await tokenResponse.json() as { token?: string };
    expect(token).toBeTruthy();
    const client = new ConvexHttpClient(fixture.convexUrl);
    client.setAuth(token!);
    for (const [index, operation] of E2E_PRIVILEGED_FUNCTIONS.entries()) {
      const key = `matrix_${role}_${index}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
      let error = "";
      try {
        await client.mutation(makeFunctionReference<"mutation">(operation.path), runtimeArgs(operation.path, fixture, key));
      } catch (caught) {
        error = String(caught);
      }
      const allowed = (operation.allowed as readonly string[]).includes(role);
      if (allowed) expect(error, `${role} ${operation.path}`).not.toContain("ADMIN_FORBIDDEN");
      else expect(error, `${role} ${operation.path}`).toContain("ADMIN_FORBIDDEN");
    }
  }
});

test("pre-provisioned auditor session reaches only its permitted browser surface", async ({ context, page }) => {
  await openAuthenticatedRolePage(context, page, "auditor", "/admin/audit", "Audit log");
  await expect(page.getByRole("link", { name: "Audit" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Conversations" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Billing" })).toHaveCount(0);
});
