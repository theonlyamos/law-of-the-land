# Admin bootstrap

**Owner:** release manager, with a Super Admin candidate present. **Abort:** production target, missing isolated non-production target, migration conflict, missing verified email or 2FA, missing provider configuration, or a failed test/build. Keep `ADMIN_PANEL_ENABLED=false` until every gate passes.

## Configuration ownership matrix

`Vercel` means project environment variables; `Convex` means the selected deployment environment. Secrets belong only to Convex. `Local`, `Preview`, and `Production` state whether the variable is required in that environment.

| Variable | Owner | Local | Preview | Production |
| --- | --- | --- | --- | --- |
| `GROUNDX_API_KEY` | Convex | Required for provider work | Required | Required |
| `GOOGLE_AI_API_KEY` | Convex | Required for generated answers | Required | Required |
| `CONVEX_DEPLOYMENT` | local shell / Vercel build | Required | Required | Required |
| `NEXT_PUBLIC_CONVEX_URL` | Vercel | Required | Required | Required |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | Vercel and Convex | Required | Required | Required |
| `NEXT_PUBLIC_SITE_URL` | Vercel | Required | Required | Required |
| `ADMIN_MAX_DOCUMENT_BYTES` | Convex | Required for admin upload | Required | Required |
| `BETTER_AUTH_SECRET` | Convex | Required | Required | Required |
| `SITE_URL` | Convex | Required | Required | Required |
| `INITIAL_SUPER_ADMIN_IDS` | Convex | Temporary bootstrap only | Temporary bootstrap only | Temporary bootstrap only |
| `GITHUB_CLIENT_ID` | Convex | Optional | Optional | Optional |
| `GITHUB_CLIENT_SECRET` | Convex | Required with GitHub OAuth | Required with GitHub OAuth | Required with GitHub OAuth |
| `GOOGLE_CLIENT_ID` | Convex | Optional | Optional | Optional |
| `GOOGLE_CLIENT_SECRET` | Convex | Required with Google OAuth | Required with Google OAuth | Required with Google OAuth |
| `RESEND_API_KEY` | Convex | Optional | Required for email delivery | Required for email delivery |
| `EMAIL_FROM` | Convex | Required with Resend | Required with Resend | Required with Resend |
| `ADMIN_PANEL_ENABLED` | Convex | Required; `false` during bootstrap | Required; `false` during bootstrap | Required; `false` during bootstrap |
| `ADMIN_ENVIRONMENT` | Convex | Required | Required | Required |
| `BILLING_ENABLED` | Convex | Required; normally `false` | Required | Required |
| `POLAR_ORGANIZATION_TOKEN` | Convex | Required when billing is enabled | Required when billing is enabled | Required when billing is enabled |
| `POLAR_WEBHOOK_SECRET` | Convex | Required when billing is enabled | Required when billing is enabled | Required when billing is enabled |
| `POLAR_SERVER` | Convex | Required; `sandbox` | Required; `sandbox` | Required; approved live value |
| `POLAR_PRO_MONTHLY_PRODUCT_ID` | Convex | Required when billing is enabled | Required when billing is enabled | Required when billing is enabled |

Bucket IDs are governed `jurisdictions` rows, not environment variables. Ghana must retain production bucket `11833` and use a distinct staging bucket. The Polar webhook is the selected Convex Site origin plus `/polar/events`.

## Callback and export controls

Remote staging ingest is callback-primary. Only after claiming an `ingest_remote` job, the action creates a one-time `gx_` token, stores its SHA-256 hash, and sends top-level GroundX `callbackUrl` and safe `callbackData`. The raw token never enters a job, scheduler argument, audit event, or log. Copy and delete do not support callbacks and therefore use the bounded 15-minute polling reconciler. A missing or non-HTTPS callback origin fails remote ingest as validation; do not silently downgrade it to polling.

Conversation exports use a hashed, one-time `exp_` reference. The browser posts it to the authenticated Next.js proxy `/api/admin/exports/download`, which forwards it to private Convex route `/admin/export-download`. Both export and reference expire within 10 minutes.

## Isolated bootstrap procedure

Use the checked-in local CLIs and the explicit `staging` deployment reference. These commands mutate the selected deployment; verify `staging` is isolated before running them.

```powershell
npx convex env set ADMIN_PANEL_ENABLED false --deployment staging
npx convex env set ADMIN_ENVIRONMENT preview --deployment staging
npx convex env set INITIAL_SUPER_ADMIN_IDS --deployment staging
npx convex run admin/migrations:seedGhanaJurisdiction '{}' --deployment staging --codegen disable
npx convex run admin/migrations:bootstrapSuperAdmins '{}' --deployment staging --codegen disable
npm test -- --maxWorkers=1
npm run build
```

Expected migration state: Ghana is enabled/default, `productionBucketId` is `11833`, the separate staging bucket is present, and a repeat seed is idempotent. Expected bootstrap state: only listed existing Better Auth users with verified email and 2FA receive `super_admin`. Abort on any unexpected row or authorization failure. Clear the allowlist immediately:

```powershell
npx convex env remove INITIAL_SUPER_ADMIN_IDS --deployment staging
```

Record GroundX as **configured**, not healthy or smoke-passed, until an authorized remote-ingest callback actually completes. The external smoke remains a release gate. If a gate fails, keep both controls disabled, preserve audit evidence, correct the fault, and repeat only on the isolated target.

## Persisted flag enable, disable, and recovery

Auth-gated public mutations are not an unauthenticated CLI recovery mechanism. A different assured, non-impersonated Super Admin must sign in and open `/admin-recovery`.

To enable the persisted row, select **Enable persisted flag**, enter a reason, type `ADMIN_PANEL preview ENABLE`, confirm the current password, and submit **Verify and enable**. Expected state is `Enabled` plus a correlation ID and one `admin.panel_flag_set` audit event. Then enable the deployment gate:

```powershell
npx convex env set ADMIN_PANEL_ENABLED true --deployment staging
```

To disable safely, keep the deployment gate on long enough to open `/admin-recovery`, select **Disable persisted flag**, enter a reason, type `ADMIN_PANEL preview DISABLE`, confirm the current password, and submit **Verify and disable**. Expected state is `Disabled` plus a correlation ID. Then run:

```powershell
npx convex env set ADMIN_PANEL_ENABLED false --deployment staging
```

Every attempt uses a newly generated idempotency key. Abort if the page reports the wrong environment, the session is impersonated/unassured, the exact confirmation differs, or no correlation ID is returned. Recovery after an aborted attempt is to leave the deployment gate false, sign in as another assured Super Admin, and retry from `/admin-recovery` with a new key.
