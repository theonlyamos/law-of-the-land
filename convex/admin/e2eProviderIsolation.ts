import { ConvexError } from "convex/values";

const ISOLATED_MARKER = "isolated-admin-e2e";
const E2E_ISOLATION_KEYS = [
  "ADMIN_E2E_FIXTURE_MODE",
  "ADMIN_E2E_TARGET_ENV",
  "ADMIN_E2E_ISOLATED_TARGET_MARKER",
  "ADMIN_E2E_PROVIDER_STUB_MODE",
  "ADMIN_E2E_CONVEX_URL",
  "ADMIN_E2E_CONVEX_SITE_URL",
  "ADMIN_E2E_APPROVED_COMMIT_SHA",
  "ADMIN_E2E_LOCAL_HEAD_SHA",
  "ADMIN_E2E_DEPLOYED_COMMIT_SHA",
  "ADMIN_E2E_PROVIDER_OBSERVATION_SECRET",
  "ADMIN_E2E_PLACE_CLAIM_SECRET",
  "ADMIN_E2E_FIXTURE_SECRET",
  "ADMIN_E2E_BETTER_AUTH_SECRET",
  "ADMIN_E2E_ACCOUNT_PASSWORD",
  "ADMIN_E2E_FIXTURE_TAG",
  "ADMIN_E2E_ROLE_SESSIONS_JSON",
  "ADMIN_E2E_SESSION_MANIFEST",
  "ADMIN_E2E_PERFORMANCE_CALIBRATION_FILE",
] as const;

/**
 * A single server-side boundary for every provider-capable E2E path.
 * Production remains unchanged when no isolation key exists. Once any
 * isolation key exists, the complete isolated stub contract is mandatory.
 */
export function resolveE2EProviderIsolation(
  environment: Record<string, string | undefined> = process.env,
): "normal" | "stub" {
  const hasE2EConfiguration = E2E_ISOLATION_KEYS.some(
    (key) => environment[key] !== undefined,
  );
  if (!hasE2EConfiguration) return "normal";
  if (
    environment.ADMIN_E2E_FIXTURE_MODE === "true" &&
    (environment.ADMIN_E2E_TARGET_ENV === "test" || environment.ADMIN_E2E_TARGET_ENV === "preview") &&
    environment.ADMIN_E2E_ISOLATED_TARGET_MARKER === ISOLATED_MARKER &&
    environment.ADMIN_E2E_PROVIDER_STUB_MODE === "true"
  ) {
    return "stub";
  }
  throw new ConvexError("E2E_PROVIDER_ISOLATION_MISCONFIGURED");
}
