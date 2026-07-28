import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/admin/global-setup.ts",
  globalTeardown: "./e2e/admin/global-teardown.ts",
  fullyParallel: false,
  // Acceptance slices launch process-isolated Convex backends. Serial workers
  // avoid CPU contention turning their five-second transactional guards flaky.
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  outputDir: "test-results/playwright",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node ./e2e/admin/start-web-server.mjs",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
