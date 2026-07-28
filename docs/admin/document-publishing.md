# Document publishing

**Owners:** Content Manager submits; a different Content Reviewer approves and publishes; Super Admin may rollback. **Abort:** no separate staging and production buckets, jurisdiction not enabled, source/checksum validation failure, reviewer equals submitter, incomplete checklist/evaluation, absent step-up proof, or a non-terminal provider job.

1. The Content Manager creates the version from Convex storage, then queues staging ingestion. Confirm the job reaches `succeeded` and the version has GroundX staging evidence. Do not ingest the same original into production.
2. The Content Manager invokes `admin/reviews:submitForReview`. A different Content Reviewer invokes `admin/reviews:approveVersion` with every checklist item true and a valid evaluation run ID.
3. The reviewer completes step-up authentication and invokes `admin/publication:publishVersion`. It requires the exact confirmation text `PUBLISH <versionId>`, a reason, and an idempotency key. The function queues one `copy_documents` job from `stagingBucketId` to `productionBucketId`.
4. Expected state is `publishing` while the copy job is `queued`, `running`, or `waiting_callback`; on terminal success the new version is `published`, the prior version is `superseded`, and the resource pointer changes atomically.

The provider callback must use the one job-specific URL described in [bootstrap](bootstrap.md). A callback is accepted only when its token hash, process ID, target type, and target ID match the job. The 15-minute reconciler polls only overdue queued, running, and waiting-callback work; it does not poll healthy callback-first work.

If publication fails, the new version returns to `approved`, records `Production copy failed`, releases the lifecycle lock, and leaves the prior production version active. Do not retry by starting a second full ingest. Open an incident, use the job console to inspect the sanitized error/correlation ID, and retry only a retryable job through `admin/jobs:retryJob`; rate-limit, timeout, and network failures are retryable. Validation, authentication, and provider failures require correction and a new approved publication attempt.
