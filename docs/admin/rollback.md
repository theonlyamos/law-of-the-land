# Rollback and compromised-admin response

## Document rollback

**Owner:** Super Admin or Content Reviewer with `document:rollback`. **Abort:** target is not `superseded`, target is active, no healthy active version exists, step-up fails, or another lifecycle outcome is uncertain.

In `/admin/review`, choose rollback for `versionId`. Password verification must issue action `document_rollback` for that target and a fresh UUID idempotency key. Invoke `admin/publication:rollbackVersion({ versionId, confirmation: "ROLLBACK <versionId>", reason, idempotencyKey })`. Expected state is `publishing`, then target `published`, former active version `superseded`, and one atomic pointer change. Failure leaves the target `superseded` with `Rollback copy failed` and preserves the active version. Abort on a missing correlation ID or unexpected status; recover through the provider-outage runbook, never by full re-ingest.

## Compromised administrator

**Owner:** a different active, 2FA-assured, non-impersonated Super Admin. **Abort:** never remove the last active Super Admin and never use the compromised session to remediate itself.

1. Before disabling either panel gate, open `/admin/users/<userId>` from the different Super Admin session. Choose **Suspend user**, provide a reason, type `BAN <userId>`, and invoke `admin/users:banUser({ userId, reason, confirmation, idempotencyKey })` with a fresh UUID. Expected state is banned with sessions revoked and a correlation ID. If any session remains, choose **Revoke all sessions**, type `REVOKE ALL <userId>`, and invoke `admin/users:revokeAllSessions` with a different UUID. Abort if the target is the last Super Admin or either result is not `succeeded`.
2. Still signed in as the different Super Admin, open `/admin-recovery`; select **Disable persisted flag**, provide the incident reason, type `ADMIN_PANEL <ADMIN_ENVIRONMENT> DISABLE`, confirm the current password, and submit. Expected state is `Disabled` plus a correlation ID.
3. Disable the deployment gate on the exact target:

   ```powershell
   npx convex env set ADMIN_PANEL_ENABLED false --deployment staging
   ```

4. Review role changes, exports, document jobs, incidents, and conversation grants by actor/correlation ID. Do not place tokens, references, keys, chats, document contents, or raw provider bodies in incident notes. Exports and references expire within 10 minutes.
5. Rotate a Better Auth/provider secret only when exposure is credible, then invalidate affected sessions. For a callback-token disclosure, wait for the known provider outcome; a fresh remote-ingest job creates a fresh token after claim.

Recovery requires incident review by another Super Admin, verified email and 2FA for any restored administrator, and an authorized provider smoke. Follow [bootstrap](bootstrap.md#persisted-flag-enable-disable-and-recovery): enable the persisted row through `/admin-recovery` while the deployment gate remains false, then set the deployment gate true. Abort and keep it false if environment, confirmation, correlation, audit, or provider checks differ.

## Full feature rollback

**Owner:** release manager with an assured Super Admin. First disable the persisted row through `/admin-recovery` using exact confirmation `ADMIN_PANEL <ADMIN_ENVIRONMENT> DISABLE`, a reason, password proof, and a fresh key. Then run `npx convex env set ADMIN_PANEL_ENABLED false --deployment staging`. Expected state: ordinary `/admin` requests fail closed while `/admin-recovery` remains available only to an assured non-impersonated Super Admin.

Do not delete jurisdictions, documents, audit events, jobs, or Ghana production mapping `11833`. Recover by fixing preview, rerunning the release checklist, enabling the persisted row with exact `ADMIN_PANEL <ADMIN_ENVIRONMENT> ENABLE`, and only then setting the deployment gate true. Use `--prod` instead of `--deployment staging` only during an explicitly approved production incident.
