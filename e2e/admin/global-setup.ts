import type { FullConfig } from "@playwright/test";
import {
  bootstrapAdminFixtures,
  cleanupAdminFixtures,
  createFixtureTag,
  defaultManifestPath,
} from "./fixture-runner";

export default async function globalSetup(_config: FullConfig) {
  const manifestPath = defaultManifestPath();
  process.env.ADMIN_E2E_SESSION_MANIFEST = manifestPath;
  const fixtureTag = createFixtureTag();
  process.env.ADMIN_E2E_FIXTURE_TAG = fixtureTag;
  try {
    await bootstrapAdminFixtures({
      environment: process.env,
      fixtureTag,
      manifestPath,
    });
  } catch (bootstrapError) {
    try {
      await cleanupAdminFixtures({ environment: process.env, manifestPath });
    } catch (cleanupError) {
      throw new AggregateError([bootstrapError, cleanupError], "Admin E2E bootstrap failed and exact recovery cleanup remains pending.");
    }
    throw bootstrapError;
  }
}
