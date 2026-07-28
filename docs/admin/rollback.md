# Rollback and compromised-admin response

## Document rollback

**Owner:** Super Admin or Content Reviewer with `document:rollback`. **Abort:** target is not `superseded`, it is already active, no healthy active version exists, step-up is absent, or the provider outcome of another lifecycle job is uncertain.

Invoke `admin/publication:rollbackVersion` only after step-up authentication, with the exact confirmation `ROLLBACK <versionId>`, an audit reason, and a new idempotency key. It queues a GroundX `copy_documents` job from the target's staging document to the jurisdiction production bucket. Expected success: the target becomes `published`, the formerly active version becomes `superseded`, and the resource pointer changes atomically. Failure leaves the target `superseded` with `Rollback copy failed` and preserves the active version.

For a failed publication, do not use rollback: the prior production version never moved, so correct the fault and re-run the approved publish flow. For a failed rollback, keep the currently active version and use the outage runbook if GroundX is unavailable.

## Compromised administrator

**Owner:** a different active Super Admin. **Abort:** do not remove the last active Super Admin; role management refuses this. Do not rely on the compromised session to remediate itself.

1. Set `ADMIN_PANEL_ENABLED=false` in the affected Convex deployment immediately. This disables admin functions even if the database flag is enabled.
2. Use the Better Auth administration flow to ban the account and revoke its sessions. Preserve audit and incident records; do not copy session tokens, export references, provider keys, chats, or document contents into notes.
3. Review role changes, exports, document jobs, and incidents by actor/correlation ID. Revoke any active conversation grants and allow export references to expire; retention removes expired grants and references.
4. Rotate the compromised Better Auth secret or provider credential in the Convex deployment when exposure is credible, then invalidate affected sessions according to the identity response plan. For a suspected GroundX callback-token disclosure, cancel only a still-queued safe job or create a fresh job after confirming the old provider outcome; each new job has a new callback token.
5. Require verified email and 2FA before restoring any administrative role. Re-enable the deployment gate only after a different Super Admin reviews the incident, access changes, exports, and provider health, then confirms the matching `admin_panel` feature flag remains the sole enabled row for `ADMIN_ENVIRONMENT`.

## Full feature rollback

**Owner:** release manager with a Super Admin. Set `ADMIN_PANEL_ENABLED=false` first, then disable the matching `admin_panel` feature flag. This is the full supported rollback because every gated admin query and mutation requires both controls. Do not delete jurisdictions, documents, audit events, or jobs as a release rollback. Keep Ghana bucket `11833` mapped as its production bucket and leave public search on the last healthy governed mapping. Recover by fixing the release in preview, rerunning the release checklist, and enabling both gates only after approval.
