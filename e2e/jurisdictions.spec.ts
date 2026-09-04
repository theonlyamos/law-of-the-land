import { expect, test, type Page } from "@playwright/test";
import {
  controlBrowserFixtures,
  installSessionCookie,
  loadBrowserFixtureManifest,
} from "./admin/fixtures";

async function chooseJurisdiction(
  page: Page,
  kind: "Geographic" | "Organizational",
  name: string,
) {
  await page.getByRole("radio", { name: kind }).click();
  const search = page.getByRole("combobox", { name: "Find jurisdiction" });
  await search.fill(name);
  const options = page
    .getByRole("listbox", { name: "Jurisdiction results" })
    .getByRole("option");
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactFixtureOption = options.filter({
    has: page.locator("span", { hasText: new RegExp(`^${escapedName}$`) }),
  });
  await expect(exactFixtureOption).toHaveCount(1);
  await expect(exactFixtureOption).toHaveAccessibleName(
    new RegExp(`^${escapedName}, ${kind}, `),
  );
  const optionCount = await options.count();
  expect(optionCount).toBeGreaterThan(0);
  expect(optionCount).toBeLessThanOrEqual(20);
  await exactFixtureOption.click();
  await expect(exactFixtureOption).toHaveAttribute("aria-selected", "true");
}

test.describe.serial("unified jurisdiction rollout evidence", () => {
  test("uses the unified selector even while the retired rollout flag is off", async ({ context, page }) => {
    const fixture = await loadBrowserFixtureManifest();
    await controlBrowserFixtures(fixture, "set_unified_jurisdictions_flag", { enabled: false });

    await context.clearCookies();
    await page.goto("/");
    await expect(page.getByRole("radiogroup", { name: "Jurisdiction type" })).toBeVisible();
    await chooseJurisdiction(page, "Geographic", `${fixture.tag} Ghana`);
  });

  test("discovers bounded public type-first results without invoking Places for organizations", async ({ context, page }) => {
    const fixture = await loadBrowserFixtureManifest();
    await controlBrowserFixtures(fixture, "set_unified_jurisdictions_flag", { enabled: true });
    await context.clearCookies();
    const placesRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/admin/geographic-places/")) placesRequests.push(request.url());
    });
    await page.goto("/");

    await chooseJurisdiction(page, "Geographic", `${fixture.tag} Ghana`);
    await chooseJurisdiction(page, "Organizational", `${fixture.tag} Public Organization`);
    expect(placesRequests).toEqual([]);
  });

  test("gives only the active member access to a member-only jurisdiction", async ({ context, page }) => {
    const fixture = await loadBrowserFixtureManifest();
    const memberName = `${fixture.tag} Member Organization`;

    await installSessionCookie(context, fixture.jurisdictionUsers.member.cookie);
    await page.goto("/");
    await chooseJurisdiction(page, "Organizational", memberName);

    for (const identity of [fixture.jurisdictionUsers.formerMember.cookie, null]) {
      if (identity) await installSessionCookie(context, identity);
      else await context.clearCookies();
      await page.goto("/");
      await page.getByRole("radio", { name: "Organizational" }).click();
      await page.getByRole("combobox", { name: "Find jurisdiction" }).fill(`${fixture.tag} Member Organization`);
      await expect(page.getByRole("option", { name: new RegExp(`${memberName}, Organizational`) })).toHaveCount(0);
    }
  });

  test("revokes selected member access on a fresh server check", async ({ context, page }) => {
    const fixture = await loadBrowserFixtureManifest();
    await installSessionCookie(context, fixture.jurisdictionUsers.member.cookie);
    await page.goto("/");
    await chooseJurisdiction(page, "Organizational", `${fixture.tag} Member Organization`);
    await controlBrowserFixtures(fixture, "deactivate_jurisdiction_member", {
      membershipId: fixture.records.jurisdictionMemberId,
    });

    await page.reload();
    await page.getByRole("radio", { name: "Organizational" }).click();
    await page.getByRole("combobox", { name: "Find jurisdiction" }).fill(`${fixture.tag} Member Organization`);
    await expect(page.getByRole("option", { name: new RegExp(`${fixture.tag} Member Organization`) })).toHaveCount(0);
  });

  test("restores the fixture flag state without restoring legacy selection", async ({ context, page }) => {
    const fixture = await loadBrowserFixtureManifest();
    await controlBrowserFixtures(fixture, "set_unified_jurisdictions_flag", { enabled: false });
    await context.clearCookies();
    await page.goto("/");
    await expect(page.getByRole("radiogroup", { name: "Jurisdiction type" })).toBeVisible();
  });
});
