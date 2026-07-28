import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import { openAuthenticatedRolePage, runAcceptanceSlice } from "./fixtures";

test("pre-provisioned super administrator reaches operational controls", async ({ context, page }) => {
  await openAuthenticatedRolePage(context, page, "super_admin", "/admin/operations", "Operations");
  await expect(page.getByRole("link", { name: "Incidents" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Audit" })).toBeVisible();
});

test("callbacks, retries, incidents, exports, and retention remain bounded and idempotent", async ({}, testInfo) => {
  await runAcceptanceSlice(
    {
      convex: ["convex/admin/jobs.test.ts", "convex/admin/retention.test.ts"],
      ui: [
        "src/components/admin/job-actions.test.tsx",
        "src/components/admin/incident-actions.test.tsx",
        "src/app/admin/operations/page.test.tsx",
        "src/app/admin/incidents/page.test.tsx",
      ],
      evidence: [
        /rejects callback token, process, target, and body mismatches and accepts replay/,
        /retries transport and rate-limit failures at 1, 5, and 20 minutes/,
        /round-robins every retention category/,
        /preserves audit, aggregates, published originals, and attached blobs/,
        /creates a new incident through the permission-gated form/,
      ],
    },
    testInfo,
  );
});
