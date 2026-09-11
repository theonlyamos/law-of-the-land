# Public jurisdiction website chat

## Operator setup

This feature defaults to unavailable. Deploy the reviewed Convex schema/functions and Next app together only after approval. Regenerate Convex types using the installed CLI as part of that authorized rollout. No existing jurisdiction is made public, no membership is elevated, and no allowance is provisioned by a migration.

Set these secrets through your deployment's secret manager; never put their values in installation snippets:

| Variable | Where | Purpose |
| --- | --- | --- |
| `WIDGET_CHAT_ENABLED=true` | Next and Convex | Explicit guest-chat kill switch; absent/false denies requests |
| `EMBED_SERVICE_SECRET` | Next and Convex | Identical random secret, at least 32 characters, for signed private requests and verified organization uploads |
| `WIDGET_IP_HASH_SECRET` | Next only | Independent random secret, at least 32 characters, for daily network identifiers |
| `NEXT_PUBLIC_CONVEX_URL` | Next | Convex API URL |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | Next | Convex HTTP actions URL |
| `SITE_URL` | Next and Convex | Exact canonical HTTPS app origin for request-origin checks, frame policy, and the saved-widget test |
| `ADMIN_MAX_DOCUMENT_BYTES` | Convex | Existing required positive document upload limit in bytes |
| `GOOGLE_AI_API_KEY` | Next | Existing Gemini integration key |
| `GOOGLE_AI_MODEL` | Next | Existing optional model override |

Production admission currently supports Vercel's trusted `x-vercel-forwarded-for` ingress header and requires `VERCEL=1`. Generic forwarded headers are never accepted. Other hosting environments fail closed until a deployment-owned trusted-IP adapter is implemented and tested. See [Vercel request headers](https://vercel.com/docs/headers/request-headers). Unit tests use a fixed loopback identity; that fallback is unavailable in production builds.

In Admin → Jurisdictions, provision an enabled organizational jurisdiction and its dedicated Gemini store using the existing setup workflow. The organization row's **Manage website chat access** control assigns existing users scoped roles and provisions the platform allowance. Start with 100 accepted questions/day, 1,000/month, and three concurrent generations. Unprovisioned organizations have zero allowance.

Members can view the workspace. Managers create/edit records, upload originals, change visibility, and configure the widget. Reviewers approve/reject and publish/unpublish/roll back. All require current organization membership and a two-factor-verified session. A manager cannot approve their own upload by acquiring the reviewer role later. Existing platform admin permissions remain separate. Role assignment does not grant platform roles.

## Organization journey

1. Open **Organizations**, choose the organization, and create a document record.
2. Upload an original. The organization upload proxy verifies its bytes and checksum before recording a reviewable version. Its limit is the lower of the configured document limit and 4 MiB, leaving room under the hosting request limit; existing administrator uploads are unchanged.
3. A different reviewer inspects the original, completes the existing checklist/evaluation record, approves, and confirms publication with password verification. Indexing runs through the existing durable jobs. **Retry safely** only resumes known recovery operations; uncertain work is never blindly uploaded again.
4. The manager makes the jurisdiction public with a separate password confirmation. Published content becomes publicly accessible; drafts and inactive versions remain excluded.
5. Open **Website chat**. Configure appearance, exact HTTPS website origins (maximum ten), and limits within the platform allowance. Enable and save. The design preview is inert; the saved-widget test uses the real allowance.
6. Copy the generated script before the closing body tag. Add it once per page. The public ID is not a secret.

Allowed websites are exact origins: `https://example.org` and `https://www.example.org` are separate. Wildcards, page paths, query strings and credentials are rejected. If the host uses CSP, permit the application origin in `script-src`, `style-src`, `connect-src`, and `frame-src`. The iframe response restricts `frame-ancestors` to saved origins plus the app origin and is never shared-cacheable.

The loader exposes only `window.LotlWidget.open()`, `.close()` and `.destroy()`. Destroy before an SPA route removes its integration, then reinstall if needed. Ordinary full-page navigation loses the in-memory conversation. Closing and reopening on the same page retains it.

## Runtime rules

- The iframe loads on first open; a session is created on first question. It has no account providers and uses no cookies or browser storage. Bearer credentials never enter URLs or parent-window messages.
- Session expiry: 30 minutes idle, 24 hours maximum. Starting over revokes the previous credential. Questions are limited to 4,000 UTF-16 code units and 32 KiB actual request bodies; session bodies are limited to 2 KiB.
- Admission atomically reserves the daily/monthly allowance and a generation lease. An accepted question counts even when generation fails or is stopped. UTC midnight and the first day of the month reset their respective buckets. Manager limits cannot exceed platform ceilings. Billing flags do not disable quotas.
- Rates: five attempts/session/minute, ten/network identifier/organization/minute, twenty session creations/network identifier/organization/ten minutes, twelve recovery reads/session/minute. One concurrent turn per session; organization ceiling defaults to three.
- A request ID is admitted once and never grants a second provider execution. Changed input under the same ID is rejected. Recovery reads do not consume another question allowance.
- Generation has a 90-second deadline; terminal writes have a 110-second bound and the host limit is 120 seconds. Stopped/uncertain provider work retains capacity until its 120-second lease ends or the provider's completion is confirmed.
- Only one dedicated organizational store is queried. Geographic links do not expand guest scope. History is at most ten completed pairs and 24 KiB UTF-8; output is capped at 4,096 tokens.
- Answer text is buffered until current access and active-version citations are validated and canonical completion is stored. The client automatically checks an interrupted answer at approximately 2, 5 and 10 seconds, then offers manual **Check answer** and explicit **Ask again**.
- Publication lifecycle, resource metadata, store/access and visibility changes advance revisions. Old sessions and stale completions fail closed. Legacy lifecycle locks lacking a jurisdiction binding conservatively block guest library access until reconciled.

## Privacy and cleanup

The visible notice links to `/privacy`. Review that page as part of deployment approval, including the operator's actual provider and infrastructure retention arrangements. Application cleanup does not imply immediate removal from backups or provider systems.

Session and turn records become deletion-eligible 24 hours after session creation. Four 15-minute cron jobs delete eligible sessions, turns, rate buckets and 90-day usage buckets in bounded batches of 100; full batches reschedule. Access checks enforce expiry even if cleanup is delayed. Aggregate usage contains counts, not prompts. Guest conversations are not exposed in organization dashboards or ordinary account exports. Do not add prompt/transcript logging to the Next routes, bridge, or operational tooling.

Monitor the oldest `widgetSessions.deleteAfter`, `widgetTurns.deleteAfter`, and bucket `expiresAt` values using their indexes. Eligible records persisting beyond the next two scheduled intervals warrant checking cron execution and failed mutations. Monitor outcome counts, latency and provider spending without recording raw network addresses or conversation content.

## Stop / rollback

Set `WIDGET_CHAT_ENABLED=false` on **both** Next and Convex to halt new admissions, reads, and completions. Disable an individual widget or make its jurisdiction private for organization-specific revocation. Preserve published documents and audit/job history; do not delete stores as a widget rollback. Allow existing leases to age out and retain the cleanup cron jobs. A UI-only rollback can leave the additive schema in place.

## Verification and remaining release gate

### Isolated browser harness

Use the existing `ADMIN_E2E_*` fixture boundary, with matching approved/local/deployed commit identities and a dedicated test backend. Enable `WIDGET_CHAT_ENABLED=true` only on that backend and set `ADMIN_MAX_DOCUMENT_BYTES=4194304`. Set its `SITE_URL=https://127.0.0.1:3110`. Generate independent test secrets for `ADMIN_E2E_EMBED_SERVICE_SECRET` and `ADMIN_E2E_WIDGET_IP_HASH_SECRET`; the backend's `EMBED_SERVICE_SECRET` must match the former.

For a local backend, use `convex deployment create local`, then `convex deployment select local`, verify the selected URLs are loopback, and start `convex dev`. Preserve the original `.env.local` before selecting the test target. Do not rely on the deprecated `convex dev --local` flag to switch an existing cloud selection. Stop the local watcher before restoring the original configuration.

The widget suite uses the existing Playwright setup/cleanup with `WIDGET_E2E=true`. Next listens on loopback port 3100; a test-only HTTPS proxy uses 3110; the Gemini transport stub uses 3219. Generate the ignored test certificate/key files before running:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout .env.widget-key.pem -out .env.widget-cert.pem -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 -days 2
```

With the fixture environment loaded, run `playwright test e2e/widget.spec.ts`. Set `WIDGET_PERF=1` to also collect 20 cold opens and 20 warm cycles; this disables Playwright tracing/screenshots during timing. The suite records raw measurements and build/browser/machine information in `test-results/playwright/**/widget-performance.json`. Test certificates, credentials, traces, and screenshots are ignored by Git. The provider transport is fixed to loopback with a dummy key; production credentials are not forwarded. Chromium's local-network permission and acceptance of the generated certificate apply only to this fixture. Production origin checks and guest authorization are unchanged.

Local verification covers origin normalization, ownership, role revocation, signed upload binding, step-up scope, publication reuse, quotas, cancellation, citation revocation, terminal buffering, inert preview, loader messaging, duplicate installation, and compressed assets. Existing publication/chat/review/upload tests are included. The production Next build passes with chat disabled and placeholder backend URLs; this does not prove a live backend rollout.

The repository's default ESLint config does not select TypeScript files. The audit uses the already-installed Next TypeScript preset for changed files without changing project-wide lint configuration. Four existing unused-symbol warnings in `convex/admin/jobs.ts` and `convex/admin/e2eFixtures.ts` remain out of scope.

Browser verification uses an authorized local Convex deployment with real authorization, uploads, publication jobs, persistence, quotas, and cleanup. Only the external Gemini transport is stubbed. The suite covers organization settings, an independent reviewer publishing a manager's upload, visibility changes, lazy embedding, persisted citations, blocked storage, and rejected origins in Chromium/Firefox/WebKit. Production activation, a real-provider acceptance query, and a physical mobile-device check remain separate release checks.

Latest local evidence (2026-09-11): **eight functional browser checks passed**, covering both management workflows in Chromium and guest embedding in Chromium, Firefox, and WebKit. The production build passed. The earlier combined **242 tests / 23 suites** passed; follow-up regression runs passed **98 tests / 8 suites**, then four focused guest tests after deferring the response parser and Markdown renderer. Convex declarations were regenerated against the local backend. Fixture teardown completed and the original development configuration was restored.

Performance remains an open release gate. The final production build (`RuVDyYOph3i23Wt3MCgN6`) measured 20 cold opens and 20 warm cycles at 390×844, 4× CPU slowdown, 150 ms latency, and 1.6 Mbps. Cold composer readiness: median **2,562 ms**, p95 **2,955 ms**, exceeding the **2,500 ms** target. Launcher feedback p95: **49 ms**; warm reopen p95: **214 ms** (includes automation overhead). Parent layout shift was zero and pre-open requests stayed within three. Loader/CSS gzip: **1,961 + 687 = 2,648 bytes**. Raw evidence is in `test-results/widget-performance-final/**/widget-performance.json`. A preceding combined run had one launcher-load failure in the timing test; the focused rerun completed all samples. These measurements do not establish physical-device or real-provider acceptance.
