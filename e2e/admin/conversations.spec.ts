import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import { openAuthenticatedRolePage, runAcceptanceSlice } from "./fixtures";

test("pre-provisioned support session reaches metadata-only conversations", async ({ context, page }) => {
  await openAuthenticatedRolePage(context, page, "support_agent", "/admin/conversations", "Conversations");
  await expect(page.getByRole("table", { name: "Conversation metadata" })).toBeVisible();
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
