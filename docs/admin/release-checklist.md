# Admin control plane release checklist

**Owner:** release manager. **Initial state:** deployment gate false and persisted row disabled. **Hard abort:** production target, non-isolated preview, absent credentials, missing 2FA, migration/bucket conflict, callback failure, test/build failure, or unresolved incident.

- [ ] Run the exact isolated bootstrap commands in [bootstrap](bootstrap.md); verify Ghana production bucket `11833`, a distinct staging bucket, idempotent seed, and cleared `INITIAL_SUPER_ADMIN_IDS`.
- [ ] Run `npm test -- --maxWorkers=1`, `npm run build`, and `npm run lint`. Run `npm run test:budgets` only with an authenticated isolated browser session and `npm run test:e2e` only against the guarded fixture target.
- [ ] Verify every privileged server path has a permission test, every high-risk success has one immutable audit/correlation, submitters cannot self-approve, and exports download only through `/api/admin/exports/download` within 10 minutes.
- [ ] Perform an authorized remote staging ingest and observe the callback success plus duplicate callback replay. Until this happens, record GroundX as **configured**, not healthy or smoke-passed. Confirm copy/delete use polling because those endpoints do not support callbacks.
- [ ] Exercise failed publication, document rollback, stuck-job recovery, retention continuation, full rollback, and compromised-admin ban/session revocation in isolated preview using each runbook's exact arguments and fresh UUID keys.
- [ ] As an assured different Super Admin, open `/admin-recovery`, verify environment `preview`, choose **Enable persisted flag**, enter a reason, type `ADMIN_PANEL preview ENABLE`, confirm the password, and require a correlation ID. Abort on any mismatch.
- [ ] Run `npx convex env set ADMIN_PANEL_ENABLED true --deployment staging`, smoke each fixed role, and monitor jobs/incidents. Recovery for any failure is persisted-flag disable through `/admin-recovery`, then `npx convex env set ADMIN_PANEL_ENABLED false --deployment staging`.

## External dry-run status

No live bootstrap, migration, provider call, code generation, or deployment was executed for this documentation change. Those operations mutate an external Convex/GroundX target, and this checkout was not supplied an isolated credentialed deployment with a pre-created verified, 2FA-enrolled allowlisted user. The exact commands are documented, but the real dry run remains externally blocked and must not be marked complete until an authorized operator records its target, outputs, callback result, and cleanup evidence.
