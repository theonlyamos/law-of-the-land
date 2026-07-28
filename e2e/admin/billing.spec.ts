import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import { openAuthenticatedRolePage, runAcceptanceSlice } from "./fixtures";

test("pre-provisioned billing session reaches allowance controls without support tools", async ({ context, page }) => {
  await openAuthenticatedRolePage(context, page, "billing_manager", "/admin/billing", "Billing");
  await expect(page.getByRole("link", { name: "Billing" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Conversations" })).toHaveCount(0);
});

test("billing roles apply bounded quota overrides without leaking secrets", async ({}, testInfo) => {
  await runAcceptanceSlice(
    {
      convex: ["convex/admin/billing.test.ts"],
      ui: ["src/components/admin/billing-actions.test.tsx"],
      evidence: [
        /denies support, blocks overlaps, and requires typed confirmation/,
        /rejects unassured and impersonated billing writers server-side/,
        /atomically refuses the next question at the effective limit/,
        /resets exactly at UTC midnight/,
        /reveals and enforces the exceptional-override confirmation/,
      ],
    },
    testInfo,
  );
});
