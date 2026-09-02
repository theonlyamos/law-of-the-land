import { test } from "@playwright/test";
import { expect, type Page } from "@playwright/test";
import { controlBrowserFixtures, loadBrowserFixtureManifest, openAuthenticatedRolePage, runAcceptanceSlice } from "./fixtures";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function versionArticle(page: Page, versionNumber: number, filename: string) {
  const fileEvidence = page.getByRole("definition").filter({
    hasText: new RegExp(`^${escapeRegExp(filename)} /`),
  });
  const authoritativeOriginal = page.getByRole("region", {
    name: "Authoritative original",
    exact: true,
  }).filter({ has: fileEvidence });
  const actions = page.getByRole("complementary", {
    name: `Actions for version ${versionNumber}`,
    exact: true,
  });
  return authoritativeOriginal.locator("xpath=ancestor::article[1]").filter({ has: actions });
}

async function waitForPublicationState(
  fixture: Awaited<ReturnType<typeof loadBrowserFixtureManifest>>,
  versionId: string,
  expectedVersionStatus: "approved" | "published" | "unpublished",
  expectedFailureSummary: string | null,
  expectedActiveVersionId: string | null,
) {
  let state = await controlBrowserFixtures(fixture, "read_state", versionId);
  await expect.poll(async () => {
    state = await controlBrowserFixtures(fixture, "read_state", versionId);
    const version = state.versions.find((row) => row.id === versionId);
    return {
      versionStatus: version?.status ?? null,
      failureSummary: version?.failureSummary ?? null,
      activeVersionId: state.activeVersionId,
    };
  }, { timeout: 15_000 }).toEqual({
    versionStatus: expectedVersionStatus,
    failureSummary: expectedFailureSummary,
    activeVersionId: expectedActiveVersionId,
  });
  return state;
}

test("pre-provisioned manager and reviewer sessions see separate document surfaces", async ({ context, page }) => {
  await openAuthenticatedRolePage(context, page, "content_manager", "/admin/documents", "Documents");
  await expect(page.getByRole("link", { name: "Review queue" })).toHaveCount(0);
  await openAuthenticatedRolePage(context, page, "content_reviewer", "/admin/review", "The publication docket");
  await expect(page.getByRole("link", { name: "Review queue" })).toBeVisible();
});

test("the reviewer who submitted a fixture version cannot approve it", async ({ context, page }) => {
  const fixture = await loadBrowserFixtureManifest();
  await openAuthenticatedRolePage(context, page, "content_reviewer", "/admin/review", "The publication docket");
  const article = versionArticle(page, 3, `${fixture.tag}-reviewer-submitted.pdf`);
  await expect(article).toContainText(`${fixture.tag}-reviewer-submitted.pdf`);
  for (const label of [
    "Official source authenticated", "Metadata is accurate", "X-Ray extraction reviewed", "Citations verified", "Search evaluation passed",
  ]) await article.getByLabel(label).check();
  await article.getByLabel("Evaluation run ID").fill(`${fixture.tag}-separation`);
  await article.getByLabel("Decision reason").fill("This same-submitter attempt must fail closed");
  await article.getByRole("button", { name: "Approve version" }).click();
  await expect(article).toContainText("ready for review");
  await expect(page.getByRole("status").filter({ hasText: "Version 3 approved" })).toHaveCount(0);
});

test("content reviewer drives failure, retry, rollback, and unpublish for exact fixture versions", async ({ context, page }) => {
  const fixture = await loadBrowserFixtureManifest();
  const versionId = fixture.records.reviewVersionId;
  await openAuthenticatedRolePage(context, page, "content_reviewer", "/admin/review", "The publication docket");
  const article = versionArticle(page, 2, `${fixture.tag}-review.pdf`);
  await expect(article).toContainText(`${fixture.tag}-review.pdf`);
  await expect(article).toContainText("ready for review");
  for (const label of [
    "Official source authenticated",
    "Metadata is accurate",
    "X-Ray extraction reviewed",
    "Citations verified",
    "Search evaluation passed",
  ]) await article.getByLabel(label).check();
  await article.getByLabel("Evaluation run ID").fill(`${fixture.tag}-evaluation`);
  await article.getByLabel("Decision reason").fill("Fixture evidence satisfies the publication checklist");
  await article.getByRole("button", { name: "Approve version" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Version 2 approved" })).toBeVisible();
  await page.reload();
  const approvedVersion = versionArticle(page, 2, `${fixture.tag}-review.pdf`);
  await expect(approvedVersion).toContainText("approved");

  await controlBrowserFixtures(fixture, "arm_provider_outcome", {
    versionId,
    publicationOperation: "publish",
    providerOutcome: "failed",
  });
  await approvedVersion.getByRole("button", { name: "Publish version" }).click();
  const dialog = page.getByRole("dialog", { name: "Publish version 2" });
  await dialog.getByLabel("Reason for this action").fill("Exercise isolated provider failure boundary");
  await dialog.getByLabel("Exact confirmation").fill(`PUBLISH ${versionId}`);
  await dialog.getByLabel("Confirm your password").fill(process.env.ADMIN_E2E_ACCOUNT_PASSWORD!);
  await dialog.getByRole("button", { name: "Queue publish" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Publish queued for version 2" })).toBeVisible();

  let state = await waitForPublicationState(fixture, versionId, "approved", "Publishing failed. The previous published version is still active.", fixture.records.publishedVersionId);
  expect(state.activeVersionId).toBe(fixture.records.publishedVersionId);
  expect(state.versions.find((row) => row.id === versionId)).toMatchObject({ status: "approved", failureSummary: "Publishing failed. The previous published version is still active." });
  expect(state.publicationJob).toMatchObject({ status: "failed", lastErrorKind: "provider" });
  await page.reload();
  const versionTwo = versionArticle(page, 2, `${fixture.tag}-review.pdf`);
  await expect(versionTwo).toContainText("approved");

  await controlBrowserFixtures(fixture, "arm_provider_outcome", {
    versionId,
    publicationOperation: "publish",
    providerOutcome: "succeeded",
  });
  await versionTwo.getByRole("button", { name: "Publish version" }).click();
  const retryDialog = page.getByRole("dialog", { name: "Publish version 2" });
  await retryDialog.getByLabel("Reason for this action").fill("Retry fixture publication after the controlled failure");
  await retryDialog.getByLabel("Exact confirmation").fill(`PUBLISH ${versionId}`);
  await retryDialog.getByLabel("Confirm your password").fill(process.env.ADMIN_E2E_ACCOUNT_PASSWORD!);
  await retryDialog.getByRole("button", { name: "Queue publish" }).click();
  state = await waitForPublicationState(fixture, versionId, "published", null, versionId);
  expect(state.activeVersionId).toBe(versionId);
  expect(state.versions.find((row) => row.id === fixture.records.publishedVersionId)?.status).toBe("superseded");

  await page.reload();
  const versionOne = versionArticle(page, 1, `${fixture.tag}-published.pdf`);
  await controlBrowserFixtures(fixture, "arm_provider_outcome", {
    versionId: fixture.records.publishedVersionId,
    publicationOperation: "rollback",
    providerOutcome: "succeeded",
  });
  await versionOne.getByRole("button", { name: "Roll back to version" }).click();
  const rollbackDialog = page.getByRole("dialog", { name: "Rollback version 1" });
  await rollbackDialog.getByLabel("Reason for this action").fill("Restore the prior fixture publication");
  await rollbackDialog.getByLabel("Exact confirmation").fill(`ROLLBACK ${fixture.records.publishedVersionId}`);
  await rollbackDialog.getByLabel("Confirm your password").fill(process.env.ADMIN_E2E_ACCOUNT_PASSWORD!);
  await rollbackDialog.getByRole("button", { name: "Queue rollback" }).click();
  state = await waitForPublicationState(fixture, fixture.records.publishedVersionId, "published", null, fixture.records.publishedVersionId);
  expect(state.activeVersionId).toBe(fixture.records.publishedVersionId);
  expect(state.versions.find((row) => row.id === versionId)?.status).toBe("superseded");

  await page.reload();
  const restoredVersion = versionArticle(page, 1, `${fixture.tag}-published.pdf`);
  await controlBrowserFixtures(fixture, "arm_provider_outcome", {
    versionId: fixture.records.publishedVersionId,
    publicationOperation: "unpublish",
    providerOutcome: "succeeded",
  });
  await restoredVersion.getByRole("button", { name: "Unpublish version" }).click();
  const unpublishDialog = page.getByRole("dialog", { name: "Unpublish version 1" });
  await unpublishDialog.getByLabel("Reason for this action").fill("Complete the isolated unpublish journey");
  await unpublishDialog.getByLabel("Exact confirmation").fill(`UNPUBLISH ${fixture.records.publishedVersionId}`);
  await unpublishDialog.getByLabel("Confirm your password").fill(process.env.ADMIN_E2E_ACCOUNT_PASSWORD!);
  await unpublishDialog.getByRole("button", { name: "Queue unpublish" }).click();
  state = await waitForPublicationState(fixture, fixture.records.publishedVersionId, "unpublished", null, null);
  expect(state.activeVersionId).toBeNull();
  expect(state.versions.find((row) => row.id === fixture.records.publishedVersionId)?.status).toBe("unpublished");
});

test("document review separates duties and preserves publication state across provider outcomes", async ({}, testInfo) => {
  await runAcceptanceSlice(
    {
      convex: [
        "convex/admin/documents.upload.test.ts",
        "convex/admin/publication.test.ts",
      ],
      ui: [
        "src/components/admin/document-upload.test.tsx",
        "src/components/admin/document-review.test.tsx",
      ],
      evidence: [
        /shows safe evidence, body-free diff, immutable decisions, and reviewer actions/,
        /restores a terminally failed index candidate and preserves the active pointer/,
        /rollback reindexes the immutable original, and unpublish deletes before clearing state/,
        /hides mutating controls from document readers/,
        /submits a verified Convex original for review without provider evidence or jobs/,
      ],
    },
    testInfo,
  );
});
