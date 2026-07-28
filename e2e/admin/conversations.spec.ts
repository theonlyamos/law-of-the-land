import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import { controlBrowserFixtures, loadBrowserFixtureManifest, openAuthenticatedRolePage, runAcceptanceSlice } from "./fixtures";

test("support agent records a grant and queues an audited conversation export through the UI", async ({ context, page }) => {
  const fixture = await loadBrowserFixtureManifest();
  const chatId = fixture.records.chatId;
  await openAuthenticatedRolePage(context, page, "support_agent", `/admin/conversations/${chatId}`, "Conversation record");
  await page.getByLabel("Purpose for access").fill("Investigate fixture support request");
  await page.getByRole("button", { name: "Open conversation" }).click();
  await expect(page.getByRole("heading", { name: "Transcript" })).toBeVisible();
  await expect(page.getByText("Fixture private question")).toBeVisible();
  await page.getByRole("button", { name: "Prepare export" }).click();
  await page.getByLabel("Reason for export").fill("Attach fixture transcript to case");
  await page.getByLabel("Exact export confirmation").fill(`EXPORT ${chatId}`);
  await page.getByLabel("Confirm your password").fill(process.env.ADMIN_E2E_ACCOUNT_PASSWORD!);
  await page.getByRole("button", { name: "Queue conversation export" }).click();
  await expect(page.getByRole("status")).toContainText(/Export queued|Export ready/);
});

test("an expired fixture grant stops transcript and export access", async ({ context, page }) => {
  const fixture = await loadBrowserFixtureManifest();
  const chatId = fixture.records.chatId;
  await openAuthenticatedRolePage(context, page, "support_agent", `/admin/conversations/${chatId}`, "Conversation record");
  await page.getByLabel("Purpose for access").fill("Exercise fixture grant expiry");
  await page.getByRole("button", { name: "Open conversation" }).click();
  await expect(page.getByText("Fixture private question")).toBeVisible();
  const state = await controlBrowserFixtures(fixture, "expire_conversation_grant");
  expect(state.grantActive).toBe(false);
  await expect(page.getByText("Fixture private question")).toHaveCount(0);
  await page.getByRole("button", { name: "Prepare export" }).click();
  await page.getByLabel("Reason for export").fill("Expired grant must fail closed");
  await page.getByLabel("Exact export confirmation").fill(`EXPORT ${chatId}`);
  await page.getByLabel("Confirm your password").fill(process.env.ADMIN_E2E_ACCOUNT_PASSWORD!);
  await page.getByRole("button", { name: "Queue conversation export" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
});

test("conversation access grants expire and exports remain bounded and secret-safe", async ({}, testInfo) => {
  await runAcceptanceSlice(
    {
      convex: ["convex/admin/conversations.access.test.ts"],
      ui: ["src/components/admin/conversation-viewer.test.tsx"],
      evidence: [
        /issues one 15-minute audit grant/,
        /rejects expired, cross-admin, cross-chat, and revoked grants/,
        /requires and consumes one fresh grant-bound step-up/,
        /sanitizes raw HTML and unsafe Markdown links/,
        /omits export controls without export permission/,
      ],
    },
    testInfo,
  );
});
