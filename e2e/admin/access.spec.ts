import { expect, test } from "@playwright/test";
import { openAuthenticatedRolePage, runAcceptanceSlice } from "./fixtures";

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

test("pre-provisioned auditor session reaches only its permitted browser surface", async ({ context, page }) => {
  await openAuthenticatedRolePage(context, page, "auditor", "/admin/audit", "Audit log");
  await expect(page.getByRole("link", { name: "Audit" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Conversations" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Billing" })).toHaveCount(0);
});
