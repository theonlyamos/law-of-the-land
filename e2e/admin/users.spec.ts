import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import { loadBrowserFixtureManifest, openAuthenticatedRolePage, runAcceptanceSlice } from "./fixtures";

test("super administrator suspends a fixture user and revokes its sessions through the UI", async ({ context, page }) => {
  const fixture = await loadBrowserFixtureManifest();
  const userId = fixture.variants.normal.userId;
  await openAuthenticatedRolePage(context, page, "super_admin", `/admin/users/${userId}`, "normal E2E fixture");
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Suspend user" }).click();
  const dialog = page.getByRole("dialog", { name: "Suspend this user?" });
  await dialog.getByLabel("Reason for this action").fill("Fixture account policy test");
  await dialog.getByLabel("Exact confirmation").fill(`BAN ${userId}`);
  await dialog.getByRole("button", { name: "Suspend user" }).click();
  await expect(page.getByRole("status")).toContainText("administrative action completed");
  await page.reload();
  await expect(page.getByText("Suspended", { exact: true })).toBeVisible();
});

test("user support actions enforce permission, step-up, ban and session revocation", async ({}, testInfo) => {
  await runAcceptanceSlice(
    {
      convex: ["convex/admin/users.actions.test.ts"],
      ui: ["src/components/admin/user-actions.test.tsx"],
      evidence: [
        /denies role assignment without the authoritative permission/,
        /executes an identical idempotent ban only once/,
        /revokes all target sessions and replays after target removal/,
        /rejects secret-bearing reasons before they reach the audit log/,
        /verifies the credential without passing it to the Convex mutation/,
      ],
    },
    testInfo,
  );
});
