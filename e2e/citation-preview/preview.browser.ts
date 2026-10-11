import { expect, test, type Page } from "@playwright/test";
import { citationPdfFixture, EXACT_QUOTE, NEXT_QUOTE } from "./fixtures";

const privatePath = "/api/chat/sources/fixture-message/0?chat=owned";

async function openPreview(page: Page, scenario = "exact", responseStatus = 200) {
  const unexpectedRequests: string[] = [];
  const pdf = await citationPdfFixture(scenario === "scan" || scenario === "duplicate" || scenario === "rotated" ? scenario : "text");
  let sourceRequests = 0;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:4179") {
      unexpectedRequests.push(url.href);
      await route.abort();
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      expect(`${url.pathname}${url.search}`).toBe(privatePath);
      sourceRequests++;
      await route.fulfill({ status: responseStatus, contentType: "application/pdf", body: pdf });
      return;
    }
    await route.continue();
  });
  await page.goto(`/?scenario=${scenario}`);
  await page.getByRole("button", { name: "Open citation", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  return { unexpectedRequests, sourceRequests: () => sourceRequests };
}

async function expectPaintedCanvas(page: Page, pageNumber: number) {
  const canvas = page.getByLabel(`PDF page ${pageNumber}`, { exact: true }).locator("canvas");
  await expect(canvas).toBeVisible();
  const rendered = await canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d")!;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonwhite = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] > 0 && pixels[index] < 220 && pixels[index + 1] < 220 && pixels[index + 2] < 220) nonwhite++;
    }
    return { width: canvas.width, height: canvas.height, nonwhite };
  });
  expect(rendered.width).toBeGreaterThan(100);
  expect(rendered.height).toBeGreaterThan(100);
  expect(rendered.nonwhite).toBeGreaterThan(20);
}

test("renders real original page, exact passage highlight, and desktop preview", async ({ page }, testInfo) => {
  const requests = await openPreview(page);
  await expect(page.getByText(/Exact passage highlighted/i)).toBeVisible();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await expectPaintedCanvas(page, 2);
  await expect(page.locator("mark")).toHaveText(EXACT_QUOTE);
  await expect(page.getByLabel("PDF page 2")).toContainText("Before dismissal, notice requirements apply.");
  const highlight = await page.locator("mark").boundingBox();
  expect(highlight?.width).toBeGreaterThan(100);
  expect(highlight?.height).toBeGreaterThan(5);
  await expect(page.getByRole("link", { name: "Open full document (opens in a new tab)" })).toHaveAttribute("href", privatePath);
  await page.screenshot({ path: testInfo.outputPath("desktop-preview.png"), fullPage: true });
  expect(requests.sourceRequests()).toBe(1);
  expect(requests.unexpectedRequests).toEqual([]);
});

test("page-only and URL page anchor jump to the cited page without inventing highlights", async ({ page }) => {
  await openPreview(page, "hash-page");
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await expect(page.getByText(/Page-only citation/i)).toBeVisible();
  await expectPaintedCanvas(page, 2);
  await expect(page.locator("mark")).toHaveCount(0);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 3 of 3", { exact: true })).toBeVisible();
  await expectPaintedCanvas(page, 3);
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await page.getByRole("spinbutton", { name: "Go to page" }).fill("1");
  await page.getByRole("spinbutton", { name: "Go to page" }).press("Enter");
  await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
  await expectPaintedCanvas(page, 1);
});

for (const [scenario, explanation] of [
  ["mismatch", /No exact passage match/i],
  ["duplicate", /appears more than once/i],
  ["scan", /No text layer/i],
] as const) {
  test(`${scenario} keeps original page visible and never highlights unsupported text`, async ({ page }) => {
    await openPreview(page, scenario);
    await expect(page.getByText(explanation)).toBeVisible();
    await expectPaintedCanvas(page, scenario === "mismatch" ? 2 : 1);
    await expect(page.locator("mark")).toHaveCount(0);
  });
}

test("moves between passages and zooms the real page without leaving stale highlights", async ({ page }) => {
  await openPreview(page, "multiple");
  await expect(page.locator("mark")).toHaveText(EXACT_QUOTE);
  await page.getByRole("button", { name: "Next passage", exact: true }).click();
  await expect(page.getByText("Page 3 of 3", { exact: true })).toBeVisible();
  await expect(page.locator("mark")).toHaveText(NEXT_QUOTE);
  const initialWidth = await page.locator("canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).width);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect.poll(async () => page.locator("canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(initialWidth);
  await expect(page.locator("mark")).toHaveText(NEXT_QUOTE);
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await expect(page.locator("mark")).toHaveText(EXACT_QUOTE);
});

test("traps keyboard navigation and restores citation focus after Escape and repeated open", async ({ page }) => {
  await openPreview(page);
  await expect(page.getByText(/Exact passage highlighted/i)).toBeVisible();
  for (const key of ["Shift+Tab", ...Array<string>(15).fill("Tab")]) {
    await page.keyboard.press(key);
    expect(await page.evaluate(() => document.querySelector("dialog")!.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open citation", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Open citation", exact: true }).click();
  await expect(page.locator("mark")).toHaveText(EXACT_QUOTE);
  await page.getByRole("button", { name: "Close source preview", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open citation", exact: true })).toBeFocused();
});

test("unavailable original has honest explanation and does not fetch another URL", async ({ page }) => {
  const requests = await openPreview(page, "unavailable");
  await expect(page.getByText("An original document preview is not available for this citation.")).toBeVisible();
  await expect(page.locator("canvas, mark")).toHaveCount(0);
  expect(requests.sourceRequests()).toBe(0);
  expect(requests.unexpectedRequests).toEqual([]);
});

test("unauthorized response stays in the dialog and offers retry", async ({ page }) => {
  await openPreview(page, "exact", 401);
  await expect(page.getByRole("alert")).toContainText("Sign in again");
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await expect(page.locator("canvas, mark")).toHaveCount(0);
});

test("out-of-range page warns and clamps to the real document", async ({ page }) => {
  await openPreview(page, "out-of-range");
  await expect(page.getByText(/outside this PDF/i)).toBeVisible();
  await expect(page.getByText("Page 3 of 3", { exact: true })).toBeVisible();
  await expectPaintedCanvas(page, 3);
  await expect(page.locator("mark")).toHaveCount(0);
});

test("narrow mobile preview fits viewport with visible controls and exact passage", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openPreview(page);
  await expect(page.getByText(/Exact passage highlighted/i)).toBeVisible();
  await expect(page.locator("mark")).toHaveText(EXACT_QUOTE);
  await expectPaintedCanvas(page, 2);
  const dialog = await page.getByRole("dialog").boundingBox();
  expect(dialog!.x).toBeGreaterThanOrEqual(0);
  expect(dialog!.width).toBeLessThanOrEqual(375);
  expect(dialog!.height).toBeLessThanOrEqual(812);
  await expect(page.getByRole("button", { name: "Close source preview", exact: true })).toBeInViewport();
  await expect(page.getByRole("link", { name: "Open full document (opens in a new tab)" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await page.screenshot({ path: testInfo.outputPath("mobile-preview.png"), fullPage: true });
});


test("rotated original page keeps its exact highlight inside the matching canvas", async ({ page }, testInfo) => {
  await openPreview(page, "rotated");
  await expect(page.getByText(/Exact passage highlighted/i)).toBeVisible();
  await expect(page.locator("mark")).toHaveText(EXACT_QUOTE);
  await expectPaintedCanvas(page, 2);
  const canvas = await page.locator("canvas").boundingBox();
  const highlight = await page.locator("mark").boundingBox();
  expect(highlight!.x).toBeGreaterThanOrEqual(canvas!.x);
  expect(highlight!.y).toBeGreaterThanOrEqual(canvas!.y);
  expect(highlight!.x + highlight!.width).toBeLessThanOrEqual(canvas!.x + canvas!.width + 1);
  expect(highlight!.y + highlight!.height).toBeLessThanOrEqual(canvas!.y + canvas!.height + 1);
  expect(highlight!.height).toBeGreaterThan(highlight!.width);
  await page.screenshot({ path: testInfo.outputPath("rotated-preview.png"), fullPage: true });
});
