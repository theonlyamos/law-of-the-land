import { defineConfig, devices } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { buildBrowserEnvironment } from "./e2e/admin/web-server-environment.mjs";

type ParentEnvironmentDependencies = {
  execFileSync(file: string, args: string[], options: { encoding: "utf8" }): string;
};

const SHA_PATTERN = /^[a-f0-9]{40}$/;

export function initializeAdminE2EProviderIsolation(
  environment: Record<string, string | undefined>,
  dependencies: ParentEnvironmentDependencies = {
    execFileSync: (file, args, options) => execFileSync(file, args, options),
  },
): void {
  const localHeadSha = dependencies.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!SHA_PATTERN.test(localHeadSha)) {
    throw new Error("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
  }
  environment.ADMIN_E2E_LOCAL_HEAD_SHA = localHeadSha;
  const approvedCommitSha = environment.ADMIN_E2E_APPROVED_COMMIT_SHA;
  if (approvedCommitSha !== undefined
    && (!SHA_PATTERN.test(approvedCommitSha) || approvedCommitSha !== localHeadSha)) {
    throw new Error("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
  }
}

initializeAdminE2EProviderIsolation(
  process.env,
);

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
    baseURL: process.env.WIDGET_E2E === "true" ? "https://127.0.0.1:3110" : "http://127.0.0.1:3000",
    ignoreHTTPSErrors: process.env.WIDGET_E2E === "true",
    launchOptions: { env: buildBrowserEnvironment(process.env) },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    ...(process.env.WIDGET_E2E === "true" ? [
      { name: "firefox", testMatch: "widget.spec.ts", grep: /@cross-browser/, use: { ...devices["Desktop Firefox"] } },
      { name: "webkit", testMatch: "widget.spec.ts", grep: /@cross-browser/, use: { ...devices["Desktop Safari"] } },
    ] : []),
  ],
  webServer: {
    command: "node ./e2e/admin/start-web-server.mjs",
    url: process.env.WIDGET_E2E === "true" ? "http://127.0.0.1:3100" : "http://127.0.0.1:3000",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
