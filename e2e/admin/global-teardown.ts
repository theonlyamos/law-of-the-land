import type { FullConfig } from "@playwright/test";
import { cleanupAdminFixtures } from "./fixture-runner";

export function clearAdminE2EParentEnvironment(environment: Record<string, string | undefined>): void {
  delete environment.ADMIN_E2E_PROVIDER_OBSERVATION_SECRET;
  delete environment.ADMIN_E2E_PLACE_CLAIM_SECRET;
  delete environment.ADMIN_E2E_SEARCH_JURISDICTION_SECRET;
  delete environment.ADMIN_E2E_TELEMETRY_INGEST_SECRET;
  delete environment.ADMIN_E2E_LOCAL_HEAD_SHA;
}

export default async function globalTeardown(_config: FullConfig) {
  const manifestPath = process.env.ADMIN_E2E_SESSION_MANIFEST;
  try {
    if (manifestPath) await cleanupAdminFixtures({ environment: process.env, manifestPath });
  } finally {
    clearAdminE2EParentEnvironment(process.env);
    delete process.env.ADMIN_E2E_SESSION_MANIFEST;
    delete process.env.ADMIN_E2E_FIXTURE_TAG;
  }
}
