import { test, expect, type Page } from "@playwright/test";
import {
  controlBrowserFixtures,
  installSessionCookie,
  loadBrowserFixtureManifest,
} from "./admin/fixtures";

test("owner creates sibling libraries, reviews their uploads, and manages scoped widgets", async ({
  context,
  page,
}, testInfo) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
  const fixture = await loadBrowserFixtureManifest();
  await installSessionCookie(context, fixture.jurisdictionUsers.member.cookie);
  await page.goto("/organizations");
  await page
    .getByRole("button", { name: "Create organization", exact: true })
    .click();
  await page
    .getByLabel("Organization name", { exact: true })
    .fill("Northstar University");
  await page.getByLabel("Website (optional)").fill("https://northstar.example");
  await page
    .getByRole("button", { name: "Create organization", exact: true })
    .click();
  await expect(page).toHaveURL(/\/organizations\/[^/]+\/jurisdictions$/);
  const organizationPath = page.url().replace(/\/jurisdictions$/, "");

  async function createAndPublish(name: string) {
    await page.goto(`${organizationPath}/jurisdictions`);
    await page
      .getByRole("button", { name: "Create jurisdiction", exact: true })
      .click();
    await page.getByLabel("Jurisdiction name", { exact: true }).fill(name);
    await page
      .getByRole("button", { name: "Create jurisdiction", exact: true })
      .click();
    await expect(page).toHaveURL(/\/jurisdictions\/[^/]+\/resources$/);
    const jurisdictionPath = page.url().replace(/\/resources$/, "");
    await page.getByRole("link", { name: "Library settings" }).click();
    await expect(
      page.getByRole("button", { name: "Enable jurisdiction" }),
    ).toBeEnabled({ timeout: 30_000 });
    await page
      .getByLabel("Reason", { exact: true })
      .fill("Open the reviewed policy library");
    await page.getByRole("button", { name: "Enable jurisdiction" }).click();
    await expect(
      page.getByRole("button", { name: "Enable jurisdiction" }),
    ).toHaveCount(0);
    await page.goto(`${jurisdictionPath}/resources`);
    await page.getByRole("button", { name: "Add document" }).click();
    await page
      .getByLabel("Document title", { exact: true })
      .fill(`${name} handbook`);
    await page.getByLabel("Issuing organization").fill("Northstar University");
    await page.getByLabel("Official citation or reference").fill(`NS-${name}`);
    await page
      .getByLabel("Official source URL", { exact: true })
      .fill("https://northstar.example/policies");
    await page.getByLabel("Effective date", { exact: true }).fill("2026-01-01");
    await page
      .getByLabel("Reason for adding")
      .fill("Publish current approved policy");
    await page
      .getByRole("button", { name: "Create document", exact: true })
      .click();
    await page
      .getByRole("link", { name: `${name} handbook`, exact: true })
      .click();
    await expect(page).toHaveURL(/\/resources\/[^/]+$/);
    const resourceUrl = page.url();
    await page
      .getByLabel("Original legal file")
      .setInputFiles({
        name: "policy.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(
          `${name}: staff receive twenty days of annual leave.`,
        ),
      });
    await page
      .getByRole("button", { name: "Upload version", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Approve version" }),
    ).toBeVisible();
    await page.getByLabel("Evaluation run ID").fill("local-owner-acceptance");
    await page
      .getByLabel("Decision reason")
      .fill("Verified original and citations");
    await page.getByRole("button", { name: "Approve version" }).click();
    await expect(
      page.getByText("The decision could not be recorded.", { exact: false }),
    ).toBeVisible();
    for (const label of [
      "Official source authenticated",
      "Metadata is accurate",
      "Original text reviewed",
      "Citations verified",
      "Search evaluation passed",
    ])
      await page.getByLabel(label, { exact: true }).check();
    await page.getByRole("button", { name: "Approve version" }).click();
    await page
      .getByRole("button", { name: "Publish version", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    const phrase = (await dialog.locator("strong").textContent())!;
    await controlBrowserFixtures(fixture, "arm_provider_outcome", {
      versionId: phrase.replace("PUBLISH ", ""),
      publicationOperation: "publish",
      providerOutcome: "succeeded",
    });
    await confirm(page, "Queue publish");
    await expect(
      page.getByRole("button", { name: "Unpublish version", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await page.goto(`${jurisdictionPath}/chat-widget`);
    await page
      .getByLabel("Chat title", { exact: true })
      .fill(`Ask about ${name}`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByText("Settings saved.", { exact: false }),
    ).toBeVisible();
    return { jurisdictionPath, resourceUrl };
  }
  const first = await createAndPublish("Employment");
  const second = await createAndPublish("Campus");
  await page.goto(`${first.jurisdictionPath}/chat-widget`);
  await expect(page.getByLabel("Chat title", { exact: true })).toHaveValue(
    "Ask about Employment",
  );
  await page.screenshot({
    path: testInfo.outputPath("chat-widget-desktop.png"),
    fullPage: true,
  });
  await page.goto(`${organizationPath}/members`);
    await expect(
      page.getByRole("heading", { name: "Members", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("cell", { name: "Owner", exact: true })).toBeVisible();
    await page.getByLabel("Email", { exact: true }).fill(`former_member.${fixture.tag}@e2e.invalid`);
    await page.getByLabel("Role").selectOption("reviewer");
    await page.getByRole("button", { name: "Send invitation", exact: true }).click();
    await expect(page.getByText("Invitation created.", { exact: false })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("members-desktop.png"),
      fullPage: true,
    });
    await installSessionCookie(context, fixture.jurisdictionUsers.formerMember.cookie);
    await page.goto("/organizations");
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(page).toHaveURL(`${organizationPath}/jurisdictions`);
    await page.goto(`${organizationPath}/members`);
    await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send invitation", exact: true })).toHaveCount(0);
    await installSessionCookie(context, fixture.jurisdictionUsers.member.cookie);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${organizationPath}/jurisdictions`);
  await expect(
    page.getByRole("link", { name: "Employment", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Campus", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("jurisdictions-mobile.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Open organization menu" }).click();
    await expect(page.getByRole("navigation", { name: "Organization", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close organization menu" }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/new");
  await page.getByLabel("Organizational", { exact: true }).check();
  await page.getByRole("combobox").fill("Northstar");
  await expect(page.getByRole("option", { name: /Employment/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Campus/ })).toBeVisible();
  await page.getByRole("option", { name: /Employment/ }).click();
    await expect(page.getByText("Selected: Northstar University / Employment", { exact: true })).toBeVisible();
  await page.goto(
    second.resourceUrl.replace(second.jurisdictionPath, first.jurisdictionPath),
  );
  await expect(
    page.getByText(/unavailable|couldn't|could not|access/i).first(),
  ).toBeVisible();
});

async function confirm(page: Page, submit: string) {
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Reason for this action")
    .fill("Local owner acceptance check");
  await dialog
    .getByLabel("Exact confirmation")
    .fill((await dialog.locator("strong").textContent())!);
  await dialog
    .getByLabel("Confirm your password")
    .fill(process.env.ADMIN_E2E_ACCOUNT_PASSWORD!);
  await dialog.getByRole("button", { name: submit, exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
