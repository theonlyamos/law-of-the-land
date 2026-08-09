# Admin control plane release checklist

**Owner:** release manager. **Initial state:** deployment gate false and persisted row disabled. Complete the isolated gates before using the separate production-promotion gates. **Hard abort:** unapproved or ambiguous target, absent credentials, missing 2FA, migration/bucket conflict, callback failure, test/build failure, or unresolved incident.

## Isolated release gates

- [ ] Run the exact isolated Bun sequence in [bootstrap](bootstrap.md), in order: frozen install; validated and typed-confirmed `CONVEX_DEPLOYMENT=dev:<deployment-name>` binding; `bunx convex dev --once`; Ghana seed; Super Admin bootstrap; `bun run test`; `bun run build`. Abort if any command resolves a target other than the pre-approved isolated deployment. Verify Ghana production bucket `11833`, a distinct staging bucket, idempotent seed, and cleared `INITIAL_SUPER_ADMIN_IDS`.
- [ ] Run `bun run lint`. Run `bun run test:budgets` only with an authenticated isolated browser session and `bun run test:e2e` only against the guarded fixture target. npm or direct Windows Node commands are troubleshooting only; after using them, rerun the required Bun release sequence from the beginning.
- [ ] Verify every privileged server path has a permission test, every high-risk success has one immutable audit/correlation, submitters cannot self-approve, and exports download only through `/api/admin/exports/download` within 10 minutes.
- [ ] Perform an authorized remote staging ingest and observe the callback success plus duplicate callback replay. Until this happens, record GroundX as **configured**, not healthy or smoke-passed. Confirm copy/delete use polling because those endpoints do not support callbacks.
- [ ] Exercise failed publication, document rollback, stuck-job recovery, retention continuation, full rollback, and compromised-admin ban/session revocation in isolated preview using each runbook's exact arguments and fresh UUID keys.
- [ ] As an assured different Super Admin, open `/admin-recovery`, verify environment `preview`, choose **Enable persisted flag**, enter a reason, type `ADMIN_PANEL preview ENABLE`, confirm the password, and require a correlation ID. Abort on any mismatch.
- [ ] In the same release shell, require `$env:CONVEX_DEPLOYMENT -ceq $env:APPROVED_ISOLATED_CONVEX_DEPLOYMENT`, run `bunx convex env set ADMIN_PANEL_ENABLED true`, smoke each fixed role, and monitor jobs/incidents. Recovery for any failure is persisted-flag disable through `/admin-recovery`, then `bunx convex env set ADMIN_PANEL_ENABLED false`. Abort instead of running either command if the binding differs.

## Production promotion gates

- [ ] Attach the completed isolated checklist, approved commit, release window, rollback owner, production Vercel project, exact production Convex deployment name, candidate, and independent approver to the change record. Do not record secrets.
- [ ] With the production deployment gate false and persisted row disabled, configure the production environments according to the [ownership matrix](bootstrap.md#configuration-ownership-matrix). Verify `ADMIN_ENVIRONMENT=production`, `INITIAL_SUPER_ADMIN_IDS` is absent, shared secrets match across runtimes, and no server secret has a `NEXT_PUBLIC_` prefix.
- [ ] Promote the approved commit through the normal `main` pipeline. Do not use an ad hoc release-shell `convex deploy`. Verify the production site is on the approved commit and ordinary `/admin` access remains disabled.
- [ ] Have the candidate create a production credential account, verify email, enroll in 2FA, and supply the production Better Auth user ID from `/settings/security`. Do not reuse a preview ID or accept credentials, authenticator secrets, codes, or backup codes.
- [ ] Run the exact-name [production bootstrap sequence](bootstrap.md#2-bind-every-bootstrap-command-to-the-exact-production-name). Require the typed target confirmation, passing test/build/lint, Ghana bucket `11833`, idempotent seed, expected role grant, forced reauthentication, and evidence that `INITIAL_SUPER_ADMIN_IDS` was removed.
- [ ] In `/admin-recovery`, verify environment `production`; type `ADMIN_PANEL production ENABLE`; require a correlation ID and one `admin.panel_flag_set` audit event. Then enable the deployment gate with the exact deployment name, smoke fixed roles, and monitor audit, jobs, incidents, auth, and providers.
- [ ] Add and verify a different assured Super Admin through the audited UI. Confirm production rollback uses `ADMIN_PANEL production DISABLE` followed by `ADMIN_PANEL_ENABLED=false` on the exact approved deployment name.

## External dry-run status

No live bootstrap, migration, provider call, code generation, or deployment was executed for this documentation change. Those operations mutate an external Convex/GroundX target, and this checkout was not supplied an isolated credentialed deployment with a pre-created verified, 2FA-enrolled allowlisted user. The exact commands are documented, but the real dry run remains externally blocked and must not be marked complete until an authorized operator records its target, outputs, callback result, and cleanup evidence.
