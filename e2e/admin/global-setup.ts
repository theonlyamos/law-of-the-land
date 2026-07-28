import type { FullConfig } from "@playwright/test";
import {
  bootstrapAdminFixtures,
  createFixtureTag,
  defaultManifestPath,
} from "./fixture-runner";

export default async function globalSetup(_config: FullConfig) {
  const manifestPath = defaultManifestPath();
  const manifest = await bootstrapAdminFixtures({
    environment: process.env,
    fixtureTag: createFixtureTag(),
    manifestPath,
  });
  process.env.ADMIN_E2E_SESSION_MANIFEST = manifestPath;
  process.env.ADMIN_E2E_ROLE_SESSIONS_JSON = JSON.stringify(manifest.sessions);
  process.env.ADMIN_E2E_FIXTURE_TAG = manifest.tag;
}
