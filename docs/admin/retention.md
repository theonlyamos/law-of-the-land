# Retention operations

**Owner:** Operations owner. **Abort manual intervention:** do not delete records or storage outside the internal retention job; it is the bounded, resumable authority.

`admin/operations:runRetentionBatch` is an internal mutation scheduled hourly. It processes at most 200 retention units per invocation and self-schedules until `done` is true. Its `retentionState` stores phase, cursor, totals, and `lastSuccessfulAt`; the supplied cursor is not an authorization token.

The implementation removes expired conversation grants and export references, expires/deletes 24-hour export artifacts, removes processed query telemetry after 90 days, redacts terminal job payload/error data after 90 days, removes expired telemetry correlations, and deletes unattached storage older than 24 hours. It does not delete legal originals attached to document versions. Each continuation writes a retention audit event; completion writes `retention.batch_completed`.

For a retention failure, create and assign an incident, inspect `retentionState.lastSuccessfulAt`, phase, cursor, and the retention audit outcome, then restore scheduler/deployment health. Expected recovery is a later scheduled batch that resumes from the persisted state and eventually sets phase `complete` with a new `lastSuccessfulAt`. Do not reset state, erase backlog, or run direct storage deletion to force completion. Escalate when `lastSuccessfulAt` remains stale across more than one hourly interval after scheduler health is restored, or when an attached legal original is at risk; keep the admin deployment gate false if the issue follows a release that could broaden deletion.
