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

const CHILD_PROVIDER_BOUNDARY_KEYS = [
  "ADMIN_E2E_FIXTURE_MODE",
  "ADMIN_E2E_TARGET_ENV",
  "ADMIN_E2E_ISOLATED_TARGET_MARKER",
  "ADMIN_E2E_PROVIDER_STUB_MODE",
  "ADMIN_E2E_CONVEX_URL",
  "ADMIN_E2E_CONVEX_SITE_URL",
  "ADMIN_E2E_APPROVED_COMMIT_SHA",
  "ADMIN_E2E_LOCAL_HEAD_SHA",
  "ADMIN_E2E_PROVIDER_OBSERVATION_SECRET",
];

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function required(environment, key) {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`Admin E2E browser server requires ${key}.`);
  return value;
}

function isLocalhost(hostname) {
  return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function isProductionLooking(hostname) {
  return /(?:^|[.:-])(?:prod|production|live)(?:[.:-]|$)/i.test(hostname);
}

function requiredExact(environment, key) {
  const value = environment[key];
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
  }
  return value;
}

function parsedEndpoint(environment, key) {
  let url;
  try {
    url = new URL(requiredExact(environment, key));
  } catch {
    throw new Error("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
  }
  return url;
}

function remoteDeploymentName(url, suffix) {
  if (!url.hostname.endsWith(suffix)) return null;
  const name = url.hostname.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) ? name : null;
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
  if (isProductionLooking(environment.CONVEX_DEPLOYMENT ?? "")) {
    throw new Error("Admin E2E browser server refuses a production Convex deployment.");
  }
  const convexUrl = parsedEndpoint(environment, "ADMIN_E2E_CONVEX_URL");
  const siteUrl = parsedEndpoint(environment, "ADMIN_E2E_CONVEX_SITE_URL");
  if (isProductionLooking(convexUrl.hostname) || isProductionLooking(siteUrl.hostname)) {
    throw new Error("Admin E2E browser server refuses production-looking fixture URLs.");
  }
  if (isLocalhost(convexUrl.hostname) !== isLocalhost(siteUrl.hostname)
    || (isLocalhost(convexUrl.hostname) && convexUrl.hostname !== siteUrl.hostname)) {
    throw new Error("Admin E2E browser server requires matching isolated Convex URLs.");
  }
  if (!isLocalhost(convexUrl.hostname)) {
    const backendName = remoteDeploymentName(convexUrl, ".convex.cloud");
    const siteName = remoteDeploymentName(siteUrl, ".convex.site");
    if (convexUrl.protocol !== "https:" || siteUrl.protocol !== "https:" || convexUrl.port || siteUrl.port || !backendName || backendName !== siteName) {
      throw new Error("Admin E2E browser server requires matching isolated Convex URLs.");
    }
  }
  const approvedCommitSha = requiredExact(environment, "ADMIN_E2E_APPROVED_COMMIT_SHA");
  const localHeadSha = requiredExact(environment, "ADMIN_E2E_LOCAL_HEAD_SHA");
  if (!SHA_PATTERN.test(approvedCommitSha) || !SHA_PATTERN.test(localHeadSha) || approvedCommitSha !== localHeadSha) {
    throw new Error("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
  }
  const observationSecret = requiredExact(environment, "ADMIN_E2E_PROVIDER_OBSERVATION_SECRET");
  const secretBytes = Buffer.from(observationSecret, "base64url");
  if (!BASE64URL_PATTERN.test(observationSecret) || observationSecret.length % 4 === 1 || secretBytes.byteLength < 32 || secretBytes.byteLength > 128 || secretBytes.toString("base64url") !== observationSecret) {
    throw new Error("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
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
  for (const key of CHILD_PROVIDER_BOUNDARY_KEYS) {
    if (environment[key] !== undefined) result[key] = environment[key];
  }
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
