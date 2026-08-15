import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { E2E_PRIVILEGED_FUNCTIONS, E2E_PROTECTED_ROUTES } from "../../convex/admin/e2eAccessMatrix";
import {
  controlBrowserFixtures,
  installSessionCookie,
  loadBrowserFixtureManifest,
  openAuthenticatedRolePage,
  roleCookie,
  runAcceptanceSlice,
} from "./fixtures";

const ADMIN_ROLES = ["super_admin", "content_manager", "content_reviewer", "support_agent", "billing_manager", "auditor"] as const;

function expectOperationSuccess(path: string, result: unknown, args: Record<string, unknown>) {
  const value = result as Record<string, unknown>;
  const operationActions: Record<string, [string, string]> = {
    "admin/users:assignRoles": ["succeeded", "roles_assign"],
    "admin/users:banUser": ["succeeded", "user_ban"],
    "admin/users:unbanUser": ["succeeded", "user_unban"],
    "admin/users:resendVerification": ["queued", "verification_resend"],
    "admin/users:revokeSession": ["succeeded", "session_revoke"],
    "admin/users:revokeAllSessions": ["succeeded", "sessions_revoke_all"],
    "admin/users:startImpersonation": ["authorized", "impersonation_start"],
    "admin/users:queueUserDeletion": ["queued", "user_deletion_queue"],
  };
  if (path === "admin/roles:setAdminRoles") return expect(value).toEqual({ changed: true, roles: ["content_manager"] });
  if (operationActions[path]) {
    const [status, action] = operationActions[path];
    expect(value).toMatchObject({ status, action, targetId: path === "admin/users:revokeSession" ? args.sessionId : args.userId });
    expect(value.correlationId).toMatch(/^op_[a-f0-9]{32}$/);
    return;
  }
  if (path === "admin/conversations:createAccessGrant") {
    expect(value.grantId).toEqual(expect.any(String)); expect(value.expiresAt).toEqual(expect.any(Number)); return;
  }
  if (path === "admin/exports:queueConversationExport") {
    expect(value).toMatchObject({ status: "queued", action: "conversation_export", targetId: args.chatId }); return;
  }
  if (path === "admin/exports:issueConversationExportReference") {
    expect(value.reference).toEqual(expect.stringMatching(/^exp_[A-Za-z0-9_-]{64}$/)); expect(value.expiresAt).toEqual(expect.any(Number)); return;
  }
  if (path === "admin/documents:generateUploadUrl") {
    expect(valueOf(result)).toMatch(/^https?:\/\//); return;
  }
  if (path === "admin/documents:createDocumentVersion" || path === "admin/resources:createJurisdiction" || path === "admin/resources:createResource") {
    expect(result).toEqual(expect.any(String)); return;
  }
  if (path === "admin/resources:updateJurisdiction") { expect(value).toMatchObject({ _id: args.id, name: expect.stringContaining("updated"), providerSyncState: "pending" }); return; }
  if (path === "admin/resources:enableJurisdiction") { expect(value).toMatchObject({ _id: args.id, status: "enabled" }); return; }
  if (path === "admin/resources:archiveJurisdiction") { expect(value).toMatchObject({ _id: args.id, status: "archived", isDefault: false }); return; }
  if (path === "admin/resources:updateResource") { expect(value).toMatchObject({ _id: args.id, title: expect.stringContaining("updated") }); return; }
  if (path === "admin/resources:archiveResource") { expect(value).toMatchObject({ _id: args.id, status: "archived" }); return; }
  if (path === "admin/resources:markResourceRepealed") { expect(value).toMatchObject({ _id: args.id, status: "repealed", repealDate: "2026-03-01" }); return; }
  const reviewStatuses: Record<string, string> = { "admin/reviews:submitForReview": "ready_for_review", "admin/reviews:approveVersion": "approved", "admin/reviews:rejectVersion": "rejected" };
  if (reviewStatuses[path]) { expect(value).toMatchObject({ status: reviewStatuses[path], versionId: args.versionId, correlationId: expect.any(String) }); return; }
  if (path.startsWith("admin/publication:")) { expect(value).toMatchObject({ jobId: expect.any(String), type: path.includes("unpublish") ? "groundx_delete" : "groundx_copy", duplicate: false, correlationId: expect.any(String) }); return; }
  if (path.startsWith("admin/billing:")) { expect(value).toMatchObject({ status: "succeeded", overrideId: expect.any(String), correlationId: expect.any(String), startsAt: expect.any(Number) }); return; }
  if (path === "admin/jobs:enqueueJob") { expect(value).toMatchObject({ jobId: expect.any(String), callbackToken: expect.stringMatching(/^gx_[a-f0-9]{64}$/), callbackTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/), duplicate: false }); return; }
  if (path === "admin/jobs:retryJob") { expect(value).toMatchObject({ jobId: args.jobId, status: "queued", correlationId: expect.any(String) }); return; }
  if (path === "admin/jobs:cancelJob") { expect(value).toMatchObject({ jobId: args.jobId, status: "cancelled", correlationId: expect.any(String) }); return; }
  if (path.startsWith("admin/operations:")) { expect(value).toMatchObject({ incidentId: expect.any(String), correlationId: expect.any(String) }); return; }
  throw new Error(`Missing authoritative result assertion for ${path}`);
}

function valueOf(value: unknown) { return String(value); }

async function expectDurableOperationSuccess(
  fixture: Awaited<ReturnType<typeof loadBrowserFixtureManifest>>,
  operation: (typeof E2E_PRIVILEGED_FUNCTIONS)[number],
  role: (typeof ADMIN_ROLES)[number],
  key: string,
  args: Record<string, unknown>,
  result: unknown,
) {
  let state: Awaited<ReturnType<typeof controlBrowserFixtures>> | undefined;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    state = await controlBrowserFixtures(fixture, "read_matrix_operation", {
      path: operation.path,
      role,
      key,
      payload: { args, result },
    });
    if (state.terminal) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(state, `${role} ${operation.path} durable state`).toMatchObject({
    path: operation.path,
    success: operation.success,
    terminal: true,
    state: expect.any(Object),
  });
}

function routePath(path: string, fixture: Awaited<ReturnType<typeof loadBrowserFixtureManifest>>) {
  return path
    .replace(":userId", fixture.records.userId)
    .replace(":chatId", fixture.records.chatId)
    .replace(":resourceId", fixture.records.resourceId);
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
  test.slow();
  const fixture = await loadBrowserFixtureManifest();
  for (const role of ADMIN_ROLES) {
    await installSessionCookie(context, await roleCookie(role));
    for (const route of E2E_PROTECTED_ROUTES) {
      const pathname = routePath(route.path, fixture);
      await page.goto(pathname);
      if ((route.allowed as readonly string[]).includes(role)) {
        await expect(page).toHaveURL(new RegExp(`${pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
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
  test.slow();
  const fixture = await loadBrowserFixtureManifest();
  for (const role of ADMIN_ROLES) {
    await installSessionCookie(context, await roleCookie(role));
    const tokenResponse = await context.request.get("/api/auth/convex/token");
    expect(tokenResponse.ok(), `${role} must obtain an isolated Convex JWT`).toBe(true);
    const { token } = await tokenResponse.json() as { token?: string };
    expect(token).toBeTruthy();
    const client = new ConvexHttpClient(fixture.convexUrl);
    client.setAuth(token!);
    for (const [index, operation] of E2E_PRIVILEGED_FUNCTIONS.entries()) {
      const key = `matrix_${role}_${index}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
      const prepared = await controlBrowserFixtures(fixture, "prepare_matrix_operation", { path: operation.path, role, key });
      expect(prepared).toMatchObject({ path: operation.path, role, success: operation.success, args: expect.any(Object) });
      const args = prepared.args!;
      let error = "";
      let result: unknown;
      try {
        result = await client.mutation(makeFunctionReference<"mutation">(operation.path), args);
      } catch (caught) {
        error = String(caught);
      }
      const allowed = (operation.allowed as readonly string[]).includes(role);
      if (allowed) {
        expect(error, `${role} ${operation.path}`).toBe("");
        expectOperationSuccess(operation.path, result, args);
        await expectDurableOperationSuccess(fixture, operation, role, key, args, result);
      } else expect(error, `${role} ${operation.path}`).toContain("ADMIN_FORBIDDEN");
    }
  }
});

test("pre-provisioned auditor session reaches only its permitted browser surface", async ({ context, page }) => {
  await openAuthenticatedRolePage(context, page, "auditor", "/admin/audit", "Audit log");
  await expect(page.getByRole("link", { name: "Audit" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Conversations" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Billing" })).toHaveCount(0);
});
