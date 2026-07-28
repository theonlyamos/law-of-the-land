import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import { openAuthenticatedRolePage, runAcceptanceSlice } from "./fixtures";

test("pre-provisioned support session reaches the accessible user register", async ({ context, page }) => {
  await openAuthenticatedRolePage(context, page, "support_agent", "/admin/users", "Users");
  await expect(page.getByRole("table", { name: "User directory" })).toBeVisible();
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
