# Admin control plane release checklist

**Owner:** release manager. **Initial state:** `ADMIN_PANEL_ENABLED=false`; the matching `admin_panel` feature flag is disabled. **Hard abort:** production target, missing isolated preview target, absent secrets/credentials, missing 2FA, failed migration, bucket conflict, callback failure, test/build failure, or an unresolved incident.

- [ ] Confirm local, preview, and production configuration follows [bootstrap](bootstrap.md); no secret is in a tracked file.
- [ ] Confirm Ghana is the governed default with production bucket `11833`, `providerSyncState` `synced`, and a separate validated staging bucket.
- [ ] In an isolated non-production target, run the exact bootstrap sequence in [bootstrap](bootstrap.md). Confirm the first migration is idempotent and allowlisted users have verified email and 2FA.
- [ ] Confirm GroundX staging ingestion, one-copy publication, callback delivery to `/groundx/callback/`, duplicate callback safety, stale-job reconciliation, failed publication preserving the prior production pointer, and document rollback.
- [ ] Confirm the provider-outage, retention, and compromised-admin procedures in their linked runbooks without exposing credentials or content.
- [ ] Run `bun run test`, `bun run build`, and `bun run test:budgets` when an authenticated isolated browser session is available. Run `bun run test:e2e` only against the isolated fixture target; it is not a production smoke test.
- [ ] Confirm all privileged server paths have permission tests, high-risk changes have immutable audits, exports are one-time and private, and submitters cannot approve their own versions.
- [ ] Only after every gate passes, set `ADMIN_PANEL_ENABLED=true` and enable exactly one `admin_panel` feature flag row for the exact `ADMIN_ENVIRONMENT`. Smoke test with a 2FA-enrolled role, then monitor jobs and incidents.

## Dry-run status

This repository's required bootstrap commands exist in `package.json` or Convex function exports. They must not be executed from an uncredentialed shared checkout: `bunx convex dev --once` selects/creates a live deployment, and both migration commands mutate its data. A real dry run therefore remains blocked until an isolated non-production Convex target with the required credentials and a pre-created allowlisted, 2FA-enrolled user is supplied. This is an external operational blocker, not a reason to enable the feature.
