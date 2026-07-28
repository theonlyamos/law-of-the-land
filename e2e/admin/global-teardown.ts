import type { FullConfig } from "@playwright/test";
import { cleanupAdminFixtures } from "./fixture-runner";

export default async function globalTeardown(_config: FullConfig) {
  const manifestPath = process.env.ADMIN_E2E_SESSION_MANIFEST;
  if (!manifestPath) return;
  try {
    await cleanupAdminFixtures({ environment: process.env, manifestPath });
  } finally {
    delete process.env.ADMIN_E2E_SESSION_MANIFEST;
    delete process.env.ADMIN_E2E_ROLE_SESSIONS_JSON;
    delete process.env.ADMIN_E2E_FIXTURE_TAG;
  }
}
