const INFRASTRUCTURE_KEYS = new Set([
  "CI",
  "COMSPEC",
  "HOME",
  "LOCALAPPDATA",
  "NODE_OPTIONS",
  "PATH",
  "PATHEXT",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
]);

function required(environment, key) {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`Admin E2E browser server requires ${key}.`);
  return value;
}

function isLocalhost(hostname) {
  return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function isProductionLooking(hostname) {
  return /(?:^|[.-])(?:prod|production|live)(?:[.-]|$)/i.test(hostname);
}

/**
 * Playwright launches webServer before global setup. Validate the same explicit
 * fixture boundary here so an inherited development environment cannot build or
 * start a browser server pointed at a live Convex deployment.
 */
export function assertIsolatedWebServerEnvironment(environment) {
  if (environment.ADMIN_E2E_FIXTURE_MODE !== "true") {
    throw new Error("Admin E2E browser server requires ADMIN_E2E_FIXTURE_MODE=true.");
  }
  if (!["test", "preview"].includes(environment.ADMIN_E2E_TARGET_ENV)) {
    throw new Error("Admin E2E browser server requires ADMIN_E2E_TARGET_ENV=test or preview.");
  }
  if (environment.ADMIN_E2E_ISOLATED_TARGET_MARKER !== "isolated-admin-e2e") {
    throw new Error("Admin E2E browser server requires the isolated target marker.");
  }
  if (environment.ADMIN_E2E_PROVIDER_STUB_MODE !== "true") {
    throw new Error("Admin E2E browser server requires ADMIN_E2E_PROVIDER_STUB_MODE=true.");
  }
  if (/^prod(?:uction)?:/i.test(environment.CONVEX_DEPLOYMENT ?? "")) {
    throw new Error("Admin E2E browser server refuses a production Convex deployment.");
  }
  const convexUrl = new URL(required(environment, "ADMIN_E2E_CONVEX_URL"));
  const siteUrl = new URL(required(environment, "ADMIN_E2E_CONVEX_SITE_URL"));
  if (!/^https?:$/.test(convexUrl.protocol) || !/^https?:$/.test(siteUrl.protocol) || convexUrl.username || convexUrl.password || siteUrl.username || siteUrl.password) {
    throw new Error("Admin E2E browser server requires credential-free HTTP(S) fixture URLs.");
  }
  if (isProductionLooking(convexUrl.hostname) || isProductionLooking(siteUrl.hostname)) {
    throw new Error("Admin E2E browser server refuses production-looking fixture URLs.");
  }
  if (isLocalhost(convexUrl.hostname) !== isLocalhost(siteUrl.hostname)) {
    throw new Error("Admin E2E browser server requires matching isolated Convex URLs.");
  }
  for (const key of ["ADMIN_E2E_FIXTURE_SECRET", "ADMIN_E2E_BETTER_AUTH_SECRET", "ADMIN_E2E_ACCOUNT_PASSWORD"]) {
    required(environment, key);
  }
}

/**
 * Builds the complete environment for the Next.js child. Playwright merges its
 * webServer environment with the parent process, so the launcher must create a
 * second child with an allowlist instead of relying on config.webServer.env.
 */
export function buildWebServerEnvironment(environment) {
  const result = buildBrowserEnvironment(environment);
  if (environment.ADMIN_E2E_CONVEX_URL) {
    result.NEXT_PUBLIC_CONVEX_URL = environment.ADMIN_E2E_CONVEX_URL;
  }
  if (environment.ADMIN_E2E_CONVEX_SITE_URL) {
    result.NEXT_PUBLIC_CONVEX_SITE_URL = environment.ADMIN_E2E_CONVEX_SITE_URL;
  }
  result.NODE_ENV = "production";
  result.NEXT_TELEMETRY_DISABLED = "1";
  return result;
}

/** Chromium receives process infrastructure only. Test-runner secrets remain
 * in the parent so fixtures can sign cookies and call guarded controls. */
export function buildBrowserEnvironment(environment) {
  const result = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && INFRASTRUCTURE_KEYS.has(key.toUpperCase())) {
      result[key] = value;
    }
  }
  return result;
}
