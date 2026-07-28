import { ConvexError } from "convex/values";

const ISOLATED_MARKER = "isolated-admin-e2e";

/**
 * A single server-side boundary for every provider-capable E2E path.
 * Production remains unchanged when no ADMIN_E2E variable exists. Once any
 * such variable exists, the complete isolated stub contract is mandatory.
 */
export function resolveE2EProviderIsolation(
  environment: Record<string, string | undefined> = process.env,
): "normal" | "stub" {
  const hasE2EConfiguration = Object.entries(environment).some(
    ([key, value]) => key.startsWith("ADMIN_E2E_") && value !== undefined,
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
