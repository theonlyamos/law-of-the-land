# Admin bootstrap

**Owner:** release manager, with a Super Admin candidate present. **Default:** use an isolated non-production target. A production bootstrap is permitted only through the separate promotion procedure below after the isolated release checklist is complete. **Abort:** unapproved or ambiguous target, migration conflict, missing verified email or 2FA, missing provider configuration, failed test/build, or unresolved incident. Keep `ADMIN_PANEL_ENABLED=false` until every gate passes.

## Configuration ownership matrix

`Vercel` means project environment variables; `Convex` means the selected deployment environment. A server-only secret can be required in both runtimes; it must have the same approved value where the two runtimes authenticate to each other. `Local`, `Preview`, and `Production` state whether the variable is required in that environment.

| Variable | Owner | Local | Preview | Production |
| --- | --- | --- | --- | --- |
| `GOOGLE_AI_API_KEY` | Vercel and Convex | Required for legal search, indexing, and generated answers | Required | Required |
| `GOOGLE_AI_MODEL` | Vercel | Optional; defaults to `gemini-3.5-flash-lite` | Optional; defaults to `gemini-3.5-flash-lite` | Optional; defaults to `gemini-3.5-flash-lite` |
| `PLACES_API_KEY` | Vercel | Required when geographic jurisdiction verification is used | Required when geographic jurisdiction verification is used | Required when geographic jurisdiction verification is used |
| `PLACE_CLAIM_SECRET` | Vercel and Convex | Required when geographic jurisdiction verification is used | Required when geographic jurisdiction verification is used | Required when geographic jurisdiction verification is used |
| `CONVEX_DEPLOYMENT` | local shell / Vercel build | Required | Required | Required |
| `NEXT_PUBLIC_CONVEX_URL` | Vercel | Required | Required | Required |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | Vercel and Convex | Required | Required | Required |
| `NEXT_PUBLIC_SITE_URL` | Vercel | Required | Required | Required |
| `SEARCH_JURISDICTION_SECRET` | Vercel and Convex | Required | Required | Required |
| `TELEMETRY_INGEST_SECRET` | Vercel and Convex | Required | Required | Required |
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

Gemini File Search store names are governed server-only `jurisdictions` fields, not environment variables or browser inputs. Create one store per jurisdiction through the audited **Set up Gemini search** action; never copy store names into release evidence. The Polar webhook is the selected Convex Site origin plus `/polar/events`.

For guarded admin E2E and performance-budget runs, provide the selected target's shared search and telemetry values to the controlling shell as `ADMIN_E2E_SEARCH_JURISDICTION_SECRET` and `ADMIN_E2E_TELEMETRY_INGEST_SECRET`. Each must be at least 32 characters. The launcher maps them to the canonical server-only names only inside the Next.js child, keeps them out of the browser and recovery manifest, and refuses bootstrap unless the isolated Convex runtime proves that its telemetry secret matches. Teardown clears the parent aliases.

## Search indexing and export controls

Only publishing queues Gemini indexing; drafts, submitted versions, review, and approval make no provider request. Accepted uploads are polled after 5, 10, 20, 30, then at most 60 seconds. After 30 minutes without confirmation, the job requires manual review and legal research for that jurisdiction remains paused. Legal research uses one File Search call across the complete server-authorized set of ready jurisdiction stores. Gemini store, document, and operation names remain server-only.

Conversation exports use a hashed, one-time `exp_` reference. The browser posts it to the authenticated Next.js proxy `/api/admin/exports/download`, which forwards it to private Convex route `/admin/export-download`. Both export and reference expire within 10 minutes.

### Disposable-development hard-cutover reset

The legacy-provider reset is a release-time procedure, not a reusable operator action. Before installing the final schema, snapshot the explicitly approved disposable development deployment, run every bounded dry-run and execute phase from the reviewed cutover artifact, and require its final verification to report no remaining legacy provider jobs, locks, fields, or active pointers. Never run the reset against preview or production. Remove the temporary mutation with the final schema, then set up each jurisdiction's Gemini search store through the controlled admin action and republish only approved versions that should be searchable.

## Isolated bootstrap procedure

### Prepare the first administrator candidate

The candidate must first create a credential account from `/signin`, open the email-verification link, sign in, and open `/settings/security`. They must confirm their current password, scan the locally rendered authenticator QR code (or enter the manual key), store the one-time backup codes offline, and verify a current six-digit code. The page then shows the candidate's Better Auth user ID. It deliberately does not show executable bootstrap commands: the release manager must use the deployment-bound sequence below. Do not accept an ID copied from an email address, URL, or application log.

The release manager must verify on `/settings/security` that the candidate shows **Email verified** and **Two-Factor is active**. OAuth-only accounts are not eligible for administration because administrative sign-in requires credential-backed Two-Factor verification. The candidate must never give the release manager their password, authenticator secret, current code, or backup codes.

The release manager must receive the exact isolated deployment identity from the approved change record as a release-shell input named `APPROVED_ISOLATED_CONVEX_DEPLOYMENT`. It is not application configuration or a secret, and its value must use the installed Convex CLI's `dev:<deployment-name>` format. Before starting, verify in the Convex dashboard that this identity is an isolated non-production deployment, `ADMIN_PANEL_ENABLED=false`, `ADMIN_ENVIRONMENT=preview`, and the temporary `INITIAL_SUPER_ADMIN_IDS` allowlist contains only the approved verified, 2FA-enrolled candidates.

Run this required release sequence literally and in order. `bunx convex dev --once` pushes the checked-in functions to the bound target before either migration runs. All three Convex commands read this same process-level `CONVEX_DEPLOYMENT` binding; none may select a different target with a per-command flag.

```powershell
bun install --frozen-lockfile

$ApprovedIsolatedDeployment = $env:APPROVED_ISOLATED_CONVEX_DEPLOYMENT
if (
  [string]::IsNullOrWhiteSpace($ApprovedIsolatedDeployment) -or
  $ApprovedIsolatedDeployment -notmatch '^dev:[a-z0-9-]+$'
) {
  throw 'Abort: APPROVED_ISOLATED_CONVEX_DEPLOYMENT must be the pre-approved isolated target in dev:<deployment-name> form.'
}

$ConfirmedIsolatedDeployment = Read-Host "Type the exact pre-approved isolated Convex target ($ApprovedIsolatedDeployment)"
if ($ConfirmedIsolatedDeployment -cne $ApprovedIsolatedDeployment) {
  throw 'Abort: the confirmed target does not match the pre-approved isolated target.'
}

$env:CONVEX_DEPLOYMENT = $ApprovedIsolatedDeployment
if ($env:CONVEX_DEPLOYMENT -cne $ApprovedIsolatedDeployment) {
  throw 'Abort: Convex target binding failed.'
}

bunx convex dev --once
bunx convex run admin/migrations:seedGhanaJurisdiction
bunx convex run admin/migrations:bootstrapSuperAdmins
bun run test
bun run build
```

Abort before `bunx convex dev --once` if the value is missing, malformed, production, or differs from the pre-approved isolated target. If any later command reports a different target identity, stop immediately, keep both admin controls disabled, and open an incident; do not continue or retry against another deployment.

Expected migration state: Ghana remains the default jurisdiction in `draft` with provider state `pending`, has no Gemini search store, and a repeat seed is idempotent. Store creation and readiness belong to the controlled admin setup action and Task 7's separately approved smoke; they are not seed output. Expected bootstrap state: only listed existing Better Auth users with verified email and 2FA receive `super_admin`. Abort on any unexpected row or authorization failure. Clear the allowlist immediately:

```powershell
bunx convex env remove INITIAL_SUPER_ADMIN_IDS
```

The first administrative grant revokes the candidate's existing sessions. The candidate must return to `/signin`, enter the credential password, and complete the authenticator or one-time backup-code challenge. They can then open `/settings/security`, which shows the active Super Administrator handoff and links to `/admin-recovery`. Never attempt to bypass this forced reauthentication by editing session records.

Record `Gemini legal search and indexing` as **Configured** only when the server-side `GOOGLE_AI_API_KEY` is nonblank. This reflects configuration, not provider health or smoke success. Task 7's separately authorized real-provider smoke remains a release gate. If a gate fails, keep both controls disabled, preserve audit evidence, correct the fault, and repeat only on the isolated target.

## Production promotion and first Super Admin

Do not reuse a preview user ID or run the isolated `convex dev` sequence against production. Better Auth users are deployment-specific. Promotion requires a completed and signed [isolated release checklist](release-checklist.md#isolated-release-gates), an approved change record, the exact production Convex deployment name copied from the Convex dashboard, and the Vercel production project identity. Record the identities, candidate, approver, planned window, and rollback owner without recording any secret values.

### 1. Deploy disabled and prepare the production account

1. In the Convex production deployment, set `ADMIN_ENVIRONMENT=production` and `ADMIN_PANEL_ENABLED=false`. Confirm `INITIAL_SUPER_ADMIN_IDS` is absent. Configure the Convex-owned variables in the matrix.
2. In the Vercel **Production** environment, configure the Vercel-owned variables in the matrix. `GOOGLE_AI_API_KEY`, `GOOGLE_AI_MODEL`, `PLACES_API_KEY`, `PLACE_CLAIM_SECRET`, `SEARCH_JURISDICTION_SECRET`, and `TELEMETRY_INGEST_SECRET` are server-only even though Vercel also needs them; never prefix them with `NEXT_PUBLIC_`. Geographic jurisdiction verification requires Vercel's `PLACES_API_KEY` and the identical 32+ character `PLACE_CLAIM_SECRET` in Vercel and Convex. The shared search and telemetry secrets must each match Convex exactly.
3. Promote the already-reviewed commit through the normal `main` deployment pipeline. Do not run an ad hoc `convex deploy` from the release shell: that command defaults to the project's production deployment and does not accept the exact-name selector used below.
4. Verify the production site loads while ordinary `/admin` access remains disabled. The candidate must create a new production credential account, verify its email, enroll in 2FA at `/settings/security`, and copy the production Better Auth user ID. Verify the production ID, email-verification state, and 2FA state in that same environment.

### 2. Bind every bootstrap command to the exact production name

Set `APPROVED_PRODUCTION_CONVEX_DEPLOYMENT` from the approved change record to the immutable deployment name shown by the Convex dashboard, such as `joyful-capybara-123`. Do not use the aliases `prod`, `production`, `staging`, `dev`, or `local`. The release manager must independently confirm in the dashboard that the name is the production deployment for this project and that the deployed commit matches the approved release.

Run the following from a clean checkout of that approved commit. The `INITIAL_SUPER_ADMIN_IDS` value is entered interactively, so it does not enter shell history. `Invoke-CheckedConvex` stops the sequence on any non-zero CLI result, and the `finally` block attempts to remove the allowlist even when a migration fails. The release remains failed until the dashboard independently confirms that the allowlist is absent.

```powershell
bun install --frozen-lockfile
bun run test
bun run build
bun run lint

$ApprovedProductionDeployment = $env:APPROVED_PRODUCTION_CONVEX_DEPLOYMENT
if (
  [string]::IsNullOrWhiteSpace($ApprovedProductionDeployment) -or
  $ApprovedProductionDeployment -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)+$' -or
  $ApprovedProductionDeployment -in @('prod', 'production', 'staging', 'dev', 'local')
) {
  throw 'Abort: APPROVED_PRODUCTION_CONVEX_DEPLOYMENT must be the exact dashboard deployment name, not an environment alias.'
}

$ConfirmedProductionDeployment = Read-Host "Type the exact approved production Convex deployment ($ApprovedProductionDeployment)"
if ($ConfirmedProductionDeployment -cne $ApprovedProductionDeployment) {
  throw 'Abort: the confirmed production target does not match the approved target.'
}

function Invoke-CheckedConvex {
  param([Parameter(Mandatory)][string[]]$CommandArgs)
  & bunx convex @CommandArgs
  if ($LASTEXITCODE -ne 0) {
    throw 'Abort: a Convex command failed. Keep both admin controls disabled and preserve its output.'
  }
}

Invoke-CheckedConvex @('env', 'set', 'INITIAL_SUPER_ADMIN_IDS', '--deployment', $ApprovedProductionDeployment)
try {
  Invoke-CheckedConvex @('run', 'admin/migrations:seedGhanaJurisdiction', '--deployment', $ApprovedProductionDeployment)
  Invoke-CheckedConvex @('run', 'admin/migrations:bootstrapSuperAdmins', '--deployment', $ApprovedProductionDeployment)
} finally {
  Invoke-CheckedConvex @('env', 'remove', 'INITIAL_SUPER_ADMIN_IDS', '--deployment', $ApprovedProductionDeployment)
}
```

The interactive allowlist must contain only the approved production user ID or comma-separated approved production user IDs. Expected state matches the isolated run: Ghana remains the default jurisdiction in `draft` with provider state `pending` and no Gemini search store, the seed is idempotent, and only existing verified, 2FA-enrolled users receive `super_admin`. Store creation and readiness require the later controlled admin setup action and Task 7's separately approved smoke; do not infer either from bootstrap. Capture redacted command results and the evidence that the allowlist was removed. Never retry with a different target after a partial failure; keep both controls disabled and open an incident.

The role grant revokes the candidate's existing sessions. The candidate must sign in again with credentials and complete the 2FA challenge. On `/settings/security`, verify the production Super Administrator handoff and then use the production enablement procedure below. At least one different assured Super Admin is required for routine recovery after the initial handoff; add that administrator through the audited admin UI before treating production setup as complete.

### Supplemental Windows troubleshooting

The Bun sequence above is the release procedure. The commands below only diagnose a local Windows launcher problem; they do not satisfy or replace any release step. After fixing Bun, restart the required sequence from `bun install --frozen-lockfile`.

```powershell
npm test -- --maxWorkers=1
npm run build
& 'C:\Program Files\nodejs\node.exe' 'node_modules\convex\bin\main.js' dev --help
```

## Unified jurisdiction ID rollout

This is a separate, additive rollout from the first-admin bootstrap. Deploy the
schema and the flag-off dual-write code before running it. The migration functions
are internal operator mutations; they never call Google or another
provider, and no step below implicitly enables the feature flag. Use only an
already approved exact target binding and placeholder values supplied through the
change record. Do not paste production deployment names, secrets, coordinates,
Place IDs, or jurisdiction IDs into this runbook.

First verify the exact environment and target, confirm
`unified_jurisdictions` is disabled, and capture the bounded output from
`getUnifiedJurisdictionRolloutState`. Independently review the canonical Ghana
Google Places projection. Then invoke the V2 seed with an exact environment,
confirmation `SEED_GHANA_JURISDICTION_V2 <environment>`, reviewed reason, fresh
8–128 character idempotency key, and operator-supplied projection. The seed must
preserve the existing Ghana ID, every legal-resource ID, and provider lifecycle
state; abort on any conflict instead of repairing it in place.

For each target below, run every returned opaque `ujm1_...` cursor to completion.
Use a new idempotency key for every page. Never copy a cursor between a target,
mode, environment, or run:

1. `chatSessions`
2. `telemetryCorrelations`
3. `queryRuns`
4. `dailyMetrics`

For each target, use the exact dry-run confirmation
`UNIFIED_JURISDICTIONS BACKFILL <environment> <target> DRY_RUN`, inspect its
`processed`, `updated`, `unresolved`, and `mismatches` counters, then repeat in
execute mode with `... EXECUTE`. After the first execute run completes, start a
second full execute run from `cursor: null`. Only that later run completing with
zero updates, unresolved rows, and mismatches persists verification evidence.
Daily metrics are patched in place; code/day and ID/day rows are never merged or
re-keyed.

The following PowerShell shape is illustrative and deliberately contains only
operator-provided placeholders. Bind `$ApprovedDeployment` and `$Environment` via
the applicable typed-confirmation procedure above before using it:

```powershell
$SeedArguments = @{
  environment = $Environment
  place = @{
    googlePlaceId = $env:APPROVED_GHANA_GOOGLE_PLACE_ID
    formattedAddress = $env:APPROVED_GHANA_FORMATTED_ADDRESS
    latitude = [double]$env:APPROVED_GHANA_LATITUDE
    longitude = [double]$env:APPROVED_GHANA_LONGITUDE
  }
  confirmation = "SEED_GHANA_JURISDICTION_V2 $Environment"
  reason = $env:APPROVED_GHANA_MIGRATION_REASON
  idempotencyKey = "ghana-v2-$([guid]::NewGuid().ToString('N'))"
} | ConvertTo-Json -Compress -Depth 4
Invoke-CheckedConvex @('run', 'admin/migrations:seedGhanaJurisdictionV2', $SeedArguments, '--deployment', $ApprovedDeployment)

$Target = 'chatSessions'
$Mode = 'DRY_RUN'
$Cursor = $null
$BackfillArguments = @{
  environment = $Environment
  target = $Target
  cursor = $Cursor
  batchSize = 100
  dryRun = ($Mode -ceq 'DRY_RUN')
  confirmation = "UNIFIED_JURISDICTIONS BACKFILL $Environment $Target $Mode"
  reason = $env:APPROVED_JURISDICTION_BACKFILL_REASON
  idempotencyKey = "ujm-$([guid]::NewGuid().ToString('N'))"
} | ConvertTo-Json -Compress
Invoke-CheckedConvex @('run', 'admin/migrations:backfillJurisdictionReferences', $BackfillArguments, '--deployment', $ApprovedDeployment)
```

After all eight dry-run/execute checkpoints and all four second clean execute
passes, capture the bounded readiness projection and require these blockers to be
absent: `GHANA_NOT_READY`, `CHAT_SESSIONS_NOT_VERIFIED`,
`TELEMETRY_CORRELATIONS_NOT_VERIFIED`, `QUERY_RUNS_NOT_VERIFIED`, and
`DAILY_METRICS_NOT_VERIFIED`. Run the complete flag-off regression before any
enablement.

The readiness read is fixed-size: at most two rollout rows, two flag rows, two rows
for each of four execute checkpoints, and at most two rows from each Ghana code,
geographic-profile, Place-ID, organizational-profile, draft-default, and
enabled-default index. It never scans a migration target. Ghana readiness requires
no organization link/profile and no other active default as well as the canonical
root-country projection.

An assured, non-impersonated Super Admin must then use the recovery control with a
fresh proof/key, reviewed reason, and exact confirmation
`UNIFIED_JURISDICTIONS <environment> ENABLE`. Enable an authorized non-production
environment first and complete the ID-first smoke/E2E. Production enablement is a
separate approval. Rollback remains available even while readiness is red: use a
fresh proof/key and `UNIFIED_JURISDICTIONS <environment> DISABLE`; do not delete
compatibility fields, historical snapshots, checkpoints, or Ghana mappings.

Readiness permits flag enablement only. It does not authorize compatibility
removal. The recommended later evidence window is 30 consecutive flag-on days with
all four targets still clean and no accepted legacy-dependent request, measured
from the later of enablement and the last dependency. An operator must explicitly
approve 30 days or choose another duration before a separate removal issue; the
application does not hard-code that policy.

## Persisted flag enable, disable, and recovery

Auth-gated public mutations are not an unauthenticated CLI recovery mechanism. For the first enablement, the newly bootstrapped Super Admin must complete the forced sign-in and 2FA challenge before opening `/admin-recovery`. After a second Super Admin exists, routine recovery must be performed by a different assured, non-impersonated Super Admin, never by the account whose access or activity is under investigation.

For preview, use environment `preview` and the isolated binding from the procedure above. To enable the persisted row, select **Enable persisted flag**, enter a reason, type `ADMIN_PANEL preview ENABLE`, confirm the current password, and submit **Verify and enable**. Expected state is `Enabled` plus a correlation ID and one `admin.panel_flag_set` audit event. Then enable the deployment gate:

```powershell
bunx convex env set ADMIN_PANEL_ENABLED true
```

To disable safely, keep the deployment gate on long enough to open `/admin-recovery`, select **Disable persisted flag**, enter a reason, type `ADMIN_PANEL preview DISABLE`, confirm the current password, and submit **Verify and disable**. Expected state is `Disabled` plus a correlation ID. Then run:

```powershell
bunx convex env set ADMIN_PANEL_ENABLED false
```

Run those preview environment commands only in the same shell after confirming `$env:CONVEX_DEPLOYMENT -ceq $env:APPROVED_ISOLATED_CONVEX_DEPLOYMENT`; otherwise abort and re-establish the approved binding. Every attempt uses a newly generated idempotency key. Abort if the page reports the wrong environment, the session is impersonated/unassured, the exact confirmation differs, or no correlation ID is returned. Recovery after an aborted attempt is to leave the deployment gate false, sign in as another assured Super Admin, and retry from `/admin-recovery` with a new key.

For production, first verify `/admin-recovery` displays environment `production`. Select **Enable persisted flag**, enter the approved reason, type `ADMIN_PANEL production ENABLE`, confirm the current password, and require the correlation ID and `admin.panel_flag_set` audit event. Only then, in the same release shell that retains the typed-confirmed exact deployment name, run:

```powershell
Invoke-CheckedConvex @('env', 'set', 'ADMIN_PANEL_ENABLED', 'true', '--deployment', $ApprovedProductionDeployment)
```

Smoke the fixed roles and monitor audit, jobs, incidents, auth, and integration configuration. Do not report provider health before Task 7's real smoke. To roll back, disable the persisted flag first with `ADMIN_PANEL production DISABLE` and a fresh idempotency key, then set the deployment gate false on the exact target:

```powershell
Invoke-CheckedConvex @('env', 'set', 'ADMIN_PANEL_ENABLED', 'false', '--deployment', $ApprovedProductionDeployment)
```

If the persisted row cannot be disabled, set the deployment gate false immediately on the exact approved production name, preserve evidence, and open an incident. Never use an alias or a candidate's session to recover itself.
