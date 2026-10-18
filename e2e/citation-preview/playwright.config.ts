import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

export default defineConfig({
  testDir: ".",
  testMatch: "preview.browser.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "line",
  outputDir: "../../test-results/citation-preview",
  use: {
    baseURL: "http://127.0.0.1:4179",
    ...devices["Desktop Chrome"],
    launchOptions: { executablePath },
    colorScheme: "light",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/prepare-citation-pdf-assets.mjs && node node_modules/vite/bin/vite.js --config e2e/citation-preview/vite.config.mts",
    cwd: "../..",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
