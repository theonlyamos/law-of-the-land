# Retention operations

**Owner:** Operations owner. **Abort manual intervention:** never delete records/storage directly or reset `retentionState`; the internal bounded job is authoritative.

`admin/operations:runRetentionBatch({ cursor: null })` runs hourly, processes at most 200 units, and self-schedules until `done` is `true`. It removes expired conversation grants, export references, and 10-minute export artifacts; processed query telemetry after 90 days; terminal job payload/error data after 90 days; expired correlations; and unattached storage older than 24 hours. Attached legal originals are never deleted.

For an authorized isolated recovery drill only, select the target explicitly and run:

```powershell
npx convex run admin/operations:runRetentionBatch '{"cursor":null}' --deployment staging --codegen disable
```

Expected output is `{ deleted, done, cursor }`; continuation is automatic, and completion sets `retentionState.phase` to `complete`, advances `lastSuccessfulAt`, and writes `retention.batch_completed`. Abort if the target is production, an attached original is at risk, or audit/state does not advance.

On failure, create an incident with `admin/operations:createIncident({ title, severity, reason, idempotencyKey })`, assign it with `updateIncident`, and inspect phase/cursor/`lastSuccessfulAt` plus the audit outcome. Each action uses a fresh UUID; no confirmation phrase applies. Recovery is a later scheduled batch resuming persisted state. Escalate if `lastSuccessfulAt` remains stale for more than one hourly interval after scheduler health returns. If the fault followed a release that could broaden deletion, keep the deployment gate false.
