import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["batch.browser.ts", "source-review.browser.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "line",
  outputDir: "../../test-results/batch-import",
  use: {
    baseURL: "http://127.0.0.1:4181",
    ...devices["Desktop Chrome"],
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    colorScheme: "light",
  },
  webServer: {
    command: "node node_modules/vite/bin/vite.js --config e2e/batch-import/vite.config.mts --configLoader runner",
    cwd: "../..",
    url: "http://127.0.0.1:4181",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
