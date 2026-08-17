import { expect, type Page, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { loadBrowserFixtureManifest, openAuthenticatedRolePage, runAcceptanceSlice } from "./fixtures";

async function findSubscriptionRow(page: Page, userId: string) {
  for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
    const row = page.getByRole("row").filter({ hasText: userId });
    const count = await row.count();
    if (count > 0) {
      expect(count, `subscription ${userId} must be unique`).toBe(1);
      return row;
    }

    const nextPage = page.getByRole("link", { name: "Next subscription page" });
    if (!(await nextPage.isVisible())) break;
    await nextPage.click();
  }

  throw new Error(`Fixture subscription ${userId} was not found within four bounded pages.`);
}

test("billing manager grants a bounded fixture quota override through the UI", async ({ context, page }) => {
  const fixture = await loadBrowserFixtureManifest();
  await openAuthenticatedRolePage(context, page, "billing_manager", "/admin/billing", "Billing");
  const row = await findSubscriptionRow(page, fixture.variants.normal.userId);
  await row.getByText("Adjust temporary allowance").click();
  await row.getByLabel("Effective question limit").fill("25");
  await row.getByLabel("Expires").fill(new Date(Date.now() + 24 * 60 * 60_000).toISOString().slice(0, 16));
  await row.getByLabel("Reason").fill("Fixture allowance verification");
  await row.getByRole("button", { name: "Grant temporary override" }).click();
  await expect(row.getByText("Allowance updated.")).toBeVisible();
  const tokenResponse = await context.request.get("/api/auth/convex/token");
  expect(tokenResponse.ok(), "billing manager must obtain an isolated Convex JWT").toBe(true);
  const { token } = await tokenResponse.json() as { token?: string };
  expect(token).toBeTruthy();
  const client = new ConvexHttpClient(fixture.convexUrl);
  client.setAuth(token!);
  await expect(client.query(
    makeFunctionReference<"query">("admin/billing:getEffectiveAllowanceForUser"),
    { userId: fixture.variants.normal.userId },
  )).resolves.toMatchObject({
    effectiveLimit: 25,
    override: {
      limit: 25,
      startsAt: expect.any(Number),
      expiresAt: expect.any(Number),
    },
  });
  await page.reload();
  await expect(await findSubscriptionRow(page, fixture.variants.normal.userId)).toContainText("25");
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
