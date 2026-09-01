import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import { controlBrowserFixtures, loadBrowserFixtureManifest, openAuthenticatedRolePage, runAcceptanceSlice } from "./fixtures";

test("super administrator opens an incident and callback replay remains idempotent", async ({ context, page, request }) => {
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
  const body = {
    callbackData: fixture.records.callbackToken,
    ingest: { processId: `${fixture.tag}-process`, status: "complete" },
  };
  expect((await request.post(callback, { data: body })).status()).toBe(202);
  expect((await request.post(callback, { data: body })).status()).toBe(202);

  const retained = await controlBrowserFixtures(fixture, "run_retention");
  expect(retained.retention.deletedTotal).toBeGreaterThan(0);
  expect(retained.callbackJob).toMatchObject({ status: "succeeded", payload: "{}" });
  expect(retained.callbackJob?.retentionRedactedAt).toEqual(expect.any(Number));
  await page.goto("/admin/operations");
  await expect(page.getByRole("region", { name: "Retention policy" })).toContainText("90 days");
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
