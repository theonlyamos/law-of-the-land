import { expect, test } from "@playwright/test";
import {
  installSessionCookie,
  loadBrowserFixtureManifest,
  roleCookie,
} from "./fixtures";

const ADMIN_DESTINATIONS = [
  "/admin",
  "/admin/users",
  "/admin/sessions",
  "/admin/conversations",
  "/admin/jurisdictions",
  "/admin/documents",
  "/admin/review",
  "/admin/billing",
  "/admin/analytics",
  "/admin/operations",
  "/admin/incidents",
  "/admin/audit",
] as const;

const RESPONSIVE_VIEWPORTS = [
  { width: 320, height: 900 },
  { width: 768, height: 900 },
  { width: 1023, height: 900 },
  { width: 1280, height: 900 },
  { width: 1440, height: 900 },
] as const;

test("every top-level administration destination stays within the viewport", async ({
  context,
  page,
}) => {
  await loadBrowserFixtureManifest();
  await installSessionCookie(context, await roleCookie("super_admin"));

  for (const viewport of RESPONSIVE_VIEWPORTS) {
    await page.setViewportSize(viewport);

    for (const pathname of ADMIN_DESTINATIONS) {
      await page.goto(pathname);
      await expect(page).toHaveURL(new RegExp(`${pathname}$`));
      await expect(page.getByRole("navigation", { name: "Administration" })).toBeVisible();

      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));

      expect(
        dimensions.scrollWidth,
        `${pathname} must not introduce page-level horizontal scrolling at ${viewport.width}px`,
      ).toBeLessThanOrEqual(dimensions.clientWidth);
    }
  }
});
