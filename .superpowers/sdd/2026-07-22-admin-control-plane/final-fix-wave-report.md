# Final review fix wave

Date: 2026-07-29
Baseline: `70ce5419f27a5e11df21ee020502b7e6ff51212b`

## Fixed in this wave

- Replaced the public generic GroundX dispatcher with internal-only scheduling and removed the duplicate public role mutation from the E2E authority surface.
- Matched the documented GroundX REST contracts: raw ingest/copy envelopes, string `callbackData`, static callback URL, `training` status, and completed-document evidence.
- Prevented automatic replay after ambiguous ingest/copy/delete transport failures.
- Added typed document staging from authoritative Convex storage, jurisdiction, resource, and version data. Staging is idempotent, lifecycle-locked, audited, and fail-closed on missing provider document evidence.
- Required authoritative target-bucket document evidence before publication records a GroundX production document ID.
- Centralized step-up actions/key validation; included publication and panel actions in the same registry.
- Required verified email plus Two Factor enrollment for administrator role grants.
- Enforced the admin feature gate on audit reads.
- Repaired affected E2E fixtures, validators, UI upload flow, and standalone TypeScript errors.

## Verification

- Focused staging/security suites: 5 files, 82 tests passed.
- Full Vitest: 60 files, 461 tests passed.
- TypeScript: `tsc --noEmit --incremental false` passed.
- ESLint: direct Node CLI passed. (`bun run lint` could not launch because the repository's Bun bin shim is corrupted.)
- Next production build: passed outside the sandbox after the sandbox denied Turbopack worker process creation.
- `git diff --check`: passed.

No deployment, provider request, network mutation, or external-system mutation was performed.

## Remaining review work

This commit is a coherent provider/security/staging slice, not a claim that the entire final review ledger is closed. Still outstanding:

- telemetry secret/config fail-fast behavior and quota debit ordering;
- Ghana migration staging/production bucket validation and runbook corrections;
- independent review-queue cursors/load-more UI;
- Better Auth preservation and login/OAuth gate migration evidence;
- retention/rollback runbook process scoping;
- search usage count/401/402 contract checks and remaining analytics/billing/UI drift.

One intentional fail-closed boundary remains: a terminal successful staging/copy callback without `progress.complete.documents[]` is rejected; polling or a later callback must provide authoritative document evidence.
