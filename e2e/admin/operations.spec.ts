import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import { controlBrowserFixtures, loadBrowserFixtureManifest, openAuthenticatedRolePage, runAcceptanceSlice } from "./fixtures";

test("super administrator opens an incident and the retired callback stays absent", async ({ context, page, request }) => {
  const fixture = await loadBrowserFixtureManifest();
  await openAuthenticatedRolePage(context, page, "super_admin", "/admin/incidents", "Incidents");
  const title = `${fixture.tag} provider incident`;
  await page.getByLabel("Incident title").fill(title);
  await page.getByLabel("Initial severity").selectOption("high");
  await page.getByLabel("Reason for opening incident").fill("Fixture provider response drill");
  await page.getByRole("button", { name: "Open incident" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Incident opened" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("row").filter({ hasText: title })).toBeVisible();

  const callback = `${fixture.convexSiteUrl}/groundx/callback`;
  expect((await request.post(callback, { data: {} })).status()).toBe(404);

  const retained = await controlBrowserFixtures(fixture, "run_retention");
  expect(retained.retention.deletedTotal).toBeGreaterThan(0);
  expect(retained.providerJob).toMatchObject({ status: "waiting_provider", payload: "{}" });
  expect(retained.providerJob?.retentionRedactedAt).toEqual(expect.any(Number));
  await page.goto("/admin/operations");
  await expect(page.getByRole("region", { name: "Retention policy" })).toContainText("90 days");
});

test("provider polling, retries, incidents, exports, and retention remain bounded and idempotent", async ({}, testInfo) => {
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
        /presents only final Gemini job types and statuses without raw provider identifiers/,
        /polls an accepted Gemini upload at 5, 10, 20, 30, then capped 60 second intervals/,
        /round-robins every retention category/,
        /preserves audit, aggregates, published originals, and attached blobs/,
        /creates a new incident through the permission-gated form/,
      ],
    },
    testInfo,
  );
});
