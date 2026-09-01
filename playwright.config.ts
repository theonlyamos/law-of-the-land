import { defineConfig, devices } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { buildBrowserEnvironment } from "./e2e/admin/web-server-environment.mjs";

type ParentEnvironmentDependencies = {
  execFileSync(file: string, args: string[], options: { encoding: "utf8" }): string;
  randomBytes(size: number): { toString(encoding: "base64url"): string };
};

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function generatedE2ESecret(dependencies: ParentEnvironmentDependencies): string {
  return dependencies.randomBytes(32).toString("base64url");
}

function validateGeneratedE2ESecret(secret: string): void {
  const secretBytes = Buffer.from(secret, "base64url");
  if (!BASE64URL_PATTERN.test(secret)
    || secretBytes.byteLength !== 32
    || secretBytes.toString("base64url") !== secret) {
    throw new Error("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
  }
}

export function initializeAdminE2EProviderIsolation(
  environment: Record<string, string | undefined>,
  dependencies: ParentEnvironmentDependencies = {
    execFileSync: (file, args, options) => execFileSync(file, args, options),
    randomBytes: (size) => randomBytes(size),
  },
  processKind: "parent" | "worker" = "parent",
): void {
  const localHeadSha = dependencies.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!SHA_PATTERN.test(localHeadSha)) {
    throw new Error("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
  }
  environment.ADMIN_E2E_LOCAL_HEAD_SHA = localHeadSha;
  const observationSecret = processKind === "worker"
    ? environment.ADMIN_E2E_PROVIDER_OBSERVATION_SECRET ?? ""
    : generatedE2ESecret(dependencies);
  if (processKind === "parent") {
    environment.ADMIN_E2E_PROVIDER_OBSERVATION_SECRET = observationSecret;
  }
  validateGeneratedE2ESecret(observationSecret);
  const approvedCommitSha = environment.ADMIN_E2E_APPROVED_COMMIT_SHA;
  if (approvedCommitSha !== undefined
    && (!SHA_PATTERN.test(approvedCommitSha) || approvedCommitSha !== localHeadSha)) {
    throw new Error("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
  }
}

initializeAdminE2EProviderIsolation(
  process.env,
  undefined,
  process.env.TEST_WORKER_INDEX === undefined ? "parent" : "worker",
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
    baseURL: "http://127.0.0.1:3000",
    launchOptions: { env: buildBrowserEnvironment(process.env) },
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
