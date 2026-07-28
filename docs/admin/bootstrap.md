# Admin bootstrap

**Owner:** release manager, with a Super Admin candidate present. **Abort:** a production target, missing isolated non-production target, a migration conflict, missing 2FA, missing GroundX configuration, or a failed test/build. Keep `ADMIN_PANEL_ENABLED=false` until every gate below passes.

## Configuration matrix

| Setting | Local | Preview | Production |
| --- | --- | --- | --- |
| `CONVEX_DEPLOYMENT`, `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CONVEX_SITE_URL` | Required | Required | Required |
| `NEXT_PUBLIC_SITE_URL`, `SITE_URL` | Required | Required | Required |
| `BETTER_AUTH_SECRET` | Required | Required | Required |
| `GROUNDX_API_KEY`, `GOOGLE_AI_API_KEY` | Required for provider smoke tests | Required | Required |
| `ADMIN_MAX_DOCUMENT_BYTES` | Required to enable uploads | Required | Required |
| `ADMIN_PANEL_ENABLED` | Required and `false` during bootstrap | Required and `false` during bootstrap | Required and `false` during bootstrap |
| `ADMIN_ENVIRONMENT` | Required when the panel is later enabled | Required when the panel is later enabled | Required when the panel is later enabled |
| `INITIAL_SUPER_ADMIN_IDS` | Required only while bootstrapping roles | Required only while bootstrapping roles | Required only while bootstrapping roles |

Set secrets only in the relevant Convex deployment. `GROUNDX_API_KEY` is the only GroundX secret in the application. Bucket IDs are governed `jurisdictions` records, not environment variables: each jurisdiction has separate `stagingBucketId` and `productionBucketId`. Ghana's migration preserves production bucket `11833`; create and validate a distinct Ghana staging bucket before document work. Do not put bucket IDs or callback tokens in browser variables.

## Callback and export controls

Each provider job creates one opaque `gx_` callback token and stores only its SHA-256 hash. Configure the provider callback URL as the Convex site route `/groundx/callback/` followed by that job's token. The callback accepts `processId`, `targetType`, `targetId`, and terminal status, and is idempotent. Rotation means creating a new job and using its newly issued callback URL; there is no deployment-wide callback-token environment variable to rotate.

Conversation exports are protected by a randomly generated, hashed, one-time `exp_` reference. The browser posts that reference to `/admin/export-download`; the response is a private, no-store NDJSON download. There is no export-signing environment variable. References expire in at most five minutes and the export itself in 24 hours.

## Controlled bootstrap sequence

Use only an isolated local or preview deployment. In the Convex deployment, set the allowlist to the already-created Better Auth user IDs, confirm each candidate has verified email and 2FA, and leave both the deployment gate and `admin_panel` feature flag disabled. Then run:

```bash
bun install --frozen-lockfile
bunx convex dev --once
bunx convex run admin/migrations:seedGhanaJurisdiction
bunx convex run admin/migrations:bootstrapSuperAdmins
bun run test
bun run build
```

Expected migration result: Ghana is enabled/default, `productionBucketId` is `11833`, `providerSyncState` is `synced`, and the seed is idempotent. Expected role result: only allowlisted existing users are promoted, and role assignment refuses a user without 2FA. Clear `INITIAL_SUPER_ADMIN_IDS` after recording the audited bootstrap result; it is not a standing access mechanism.

Before release, confirm the distinct staging bucket, provider callback delivery, and admin smoke tests. Only then set the deployment gate to `true` and create exactly one enabled `featureFlags` `admin_panel` row whose environment equals the exact, non-blank `ADMIN_ENVIRONMENT` value. If any check fails, leave the gate false, remove the temporary allowlist, preserve the audit evidence, and resolve the failed check before repeating the non-production sequence.
