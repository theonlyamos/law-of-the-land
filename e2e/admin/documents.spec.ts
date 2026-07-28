import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import { openAuthenticatedRolePage, runAcceptanceSlice } from "./fixtures";

test("pre-provisioned manager and reviewer sessions see separate document surfaces", async ({ context, page }) => {
  await openAuthenticatedRolePage(context, page, "content_manager", "/admin/documents", "Documents");
  await expect(page.getByRole("link", { name: "Review queue" })).toHaveCount(0);
  await openAuthenticatedRolePage(context, page, "content_reviewer", "/admin/review", "The publication docket");
  await expect(page.getByRole("link", { name: "Review queue" })).toBeVisible();
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
        /reviewer separation with immutable evidence/,
        /preserves the prior active version on copy failure/,
        /callback-driven unpublish and rollback/,
        /hides mutating controls from document readers/,
        /labels missing provider evidence as unavailable/,
      ],
    },
    testInfo,
  );
});
