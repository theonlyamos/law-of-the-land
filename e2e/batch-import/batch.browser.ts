import { expect, test, type Page } from "@playwright/test";

function manifest(count = 1) {
  return {
    version: 1,
    jurisdictionId: "ghana-fixture",
    documents: Array.from({ length: count }, (_, index) => ({
      filename: `judgment-${index + 1}.pdf`,
      title: `Fixture judgment ${index + 1}`,
      issuer: "Supreme Court of Ghana",
      officialCitation: `[2020] GHASC ${index + 1}`,
      sourceUrl: `https://example.org/originals/judgment-${index + 1}.pdf`,
      sourceProvenance: "Court text reproduced by a third-party host. Source authentication is pending human review.",
      topics: ["employment"],
      caseAliases: [`Fixture appellant ${index + 1} v respondent`],
    })),
  };
}
function pdf(index = 1) {
  return { name: `judgment-${index}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.7\nBrowser fixture judgment ${index}\n%%EOF`) };
}
async function load(page: Page, count = 1) {
  await page.getByLabel("Manifest JSON", { exact: true }).fill(JSON.stringify(manifest(count)));
  await page.getByRole("button", { name: "Load manifest", exact: true }).click();
  await expect(page.getByText("Ghana", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Judgment PDFs", { exact: true }).setInputFiles(Array.from({ length: count }, (_, index) => pdf(index + 1)));
}
async function backend(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("batch-import-fixture-backend") ?? "{}") as {
    uploads: number; commits: number; receipts: Record<string, { status: string; indexed: boolean }>;
  });
}

test("imports each PDF once under repeated clicks and exposes manual review and truthful provenance", async ({ page }) => {
  await page.goto("/");
  await load(page, 2);
  await page.getByRole("button", { name: "Prepare duplicate checks", exact: true }).click();
  await expect(page.getByText(/Catalog duplicate checks are ready/)).toBeVisible();
  expect((await backend(page)).uploads).toBe(0);
  expect((await backend(page)).commits).toBe(0);
  await page.getByRole("button", { name: "Upload pending PDFs", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.getByRole("link", { name: "Review document", exact: true })).toHaveCount(2);
  expect((await backend(page)).commits).toBe(2);
  expect((await backend(page)).uploads).toBe(2);
  await expect(page.getByText(/third-party host/).first()).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Review document", exact: true }).first()).toHaveAttribute("href", /\/admin\/review\?versionId=/);
});

test("retries an interrupted upload and preserves metadata", async ({ page }) => {
  await page.goto("/?scenario=upload-error");
  await load(page);
  await page.getByRole("button", { name: "Upload pending PDFs", exact: true }).click();
  await expect(page.getByRole("button", { name: "Upload pending PDFs", exact: true })).toBeEnabled();
  expect((await backend(page)).commits).toBe(0);
  await expect(page.getByText("Fixture judgment 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Upload pending PDFs", exact: true }).click();
  await expect(page.getByRole("link", { name: "Review document", exact: true })).toBeVisible();
  expect((await backend(page)).commits).toBe(1);
  expect((await backend(page)).uploads).toBe(2);
});

test("stops an in-flight upload and safely resumes", async ({ page }) => {
  await page.goto("/?scenario=slow-upload");
  await load(page);
  await page.getByRole("button", { name: "Upload pending PDFs", exact: true }).click();
  await expect.poll(async () => (await backend(page)).uploads).toBe(1);
  await page.getByRole("button", { name: "Stop uploads", exact: true }).click();
  await expect(page.getByRole("button", { name: "Upload pending PDFs", exact: true })).toBeEnabled();
  expect((await backend(page)).commits).toBe(0);
  await page.getByRole("button", { name: "Upload pending PDFs", exact: true }).click();
  await expect(page.getByRole("link", { name: "Review document", exact: true })).toBeVisible();
  expect((await backend(page)).commits).toBe(1);
});

test("reconciles a committed original after its response is lost", async ({ page }) => {
  await page.goto("/?scenario=lost-commit");
  await load(page);
  await page.getByRole("button", { name: "Upload pending PDFs", exact: true }).click();
  await expect.poll(async () => (await backend(page)).commits).toBe(1);
  await expect(page.getByRole("button", { name: "Upload pending PDFs", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Upload pending PDFs", exact: true }).click();
  await expect(page.getByRole("link", { name: "Review document", exact: true })).toBeVisible();
  expect((await backend(page)).commits).toBe(1);
  expect((await backend(page)).uploads).toBe(1);
});

test("shows live publication and indexing states without marking review complete", async ({ page }) => {
  await page.goto("/");
  await load(page);
  await page.getByRole("button", { name: "Upload pending PDFs", exact: true }).click();
  await expect(page.getByRole("link", { name: "Review document", exact: true })).toBeVisible();
  await expect(page.getByText("ready for review", { exact: true })).toBeVisible();
  await expect(page.getByText("Not confirmed", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("batch-import-fixture-backend")!);
    for (const row of Object.values(state.receipts) as Array<{ status: string; indexed: boolean }>) {
      row.status = "published";
      row.indexed = true;
    }
    localStorage.setItem("batch-import-fixture-backend", JSON.stringify(state));
    window.dispatchEvent(new Event("fixture-backend-change"));
  });
  await expect(page.getByText("published", { exact: true })).toBeVisible();
  await expect(page.getByText("Indexed", { exact: true })).toBeVisible();
});

test("navigation aborts local upload work and restores the saved batch for PDF reselection", async ({ page }) => {
  await page.goto("/?scenario=slow-upload");
  await load(page);
  await page.getByRole("button", { name: "Upload pending PDFs", exact: true }).click();
  await expect.poll(async () => (await backend(page)).uploads).toBe(1);
  await page.getByRole("link", { name: "Fixture navigation away", exact: true }).click();
  await expect(page).toHaveURL(/\/away$/);
  await expect(page.getByText("Fixture judgment 1", { exact: true })).toBeVisible();
  expect((await backend(page)).commits).toBe(0);
  await page.getByLabel("Judgment PDFs", { exact: true }).setInputFiles(pdf());
  await page.getByRole("button", { name: "Upload pending PDFs", exact: true }).click();
  await expect(page.getByRole("link", { name: "Review document", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Saved manifest restored/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Review document", exact: true })).toHaveCount(0);
  await page.getByLabel("Judgment PDFs", { exact: true }).setInputFiles(pdf());
  await page.getByRole("button", { name: "Upload pending PDFs", exact: true }).click();
  await expect(page.getByRole("link", { name: "Review document", exact: true })).toBeVisible();
  expect((await backend(page)).commits).toBe(1);
});

test("mobile layout keeps metadata, source and controls within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await load(page, 2);
  await expect(page.getByRole("button", { name: "Upload pending PDFs", exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: "test-results/batch-import/mobile-manifest.png", fullPage: true });
});

test("a delayed commit cannot restore a cleared batch after client navigation", async ({ page }) => {
  await page.goto("/?scenario=delayed-commit");
  await load(page);
  await page.getByRole("button", { name: "Upload pending PDFs", exact: true }).click();
  await expect.poll(async () => (await backend(page)).commits).toBe(1);
  await page.getByRole("button", { name: "Fixture navigate away", exact: true }).click();
  await expect(page.getByText("Fixture route away from batch screen.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Fixture return to batch", exact: true }).click();
  await expect(page.getByText(/Saved manifest restored/)).toBeVisible();
  await page.getByRole("button", { name: "Clear saved batch", exact: true }).click();
  await expect(page.getByText("Fixture judgment 1", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Resolve delayed commit", exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("judgment-batch-v1:batch-browser-admin"))).toBeNull();
  await expect(page.getByText("Fixture judgment 1", { exact: true })).toHaveCount(0);
  expect((await backend(page)).commits).toBe(1);
});
