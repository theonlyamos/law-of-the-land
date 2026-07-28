# GroundX provider outage and stuck jobs

**Owner:** on-call Super Admin or Operations owner. **Abort all dependent work:** confirmed provider authentication failure, sustained rate limiting, network/timeout errors after the built-in retry budget, or uncertainty about a document's provider outcome. User lookup, audit, and unrelated administration remain available.

1. Open a `systemIncident` using `admin/operations:createIncident`; use `critical` when public legal search or active publication is affected. Assign an owner with `admin/operations:updateIncident` and record only sanitized observations with `admin/operations:addIncidentNote`.
2. In the job console, inspect `admin/jobs:listJobs` by status and correlation ID. Expected automatic behavior is retry after 1, 5, and 20 minutes for `rate_limit`, `timeout`, and `network`; after that the job becomes `manual_review`. Authentication, validation, and other permanent errors become `failed`.
3. Do not cancel a running, waiting-callback, manual-review, or any document-version job: the implementation rejects it because the external outcome is uncertain. The only cancellable job is queued, has no lease/process, and is not a document version.
4. For a `manual_review` job with a process ID and `network`, `timeout`, or `rate_limit`, correct the provider condition and use `admin/jobs:retryJob` with a reason and a new idempotency key. Expected result is `running`; reconciliation then uses the same GroundX outcome path as a callback.
5. Leave publication locked until a terminal provider outcome is known. The reconciler runs every 15 minutes. A lifecycle lock reaches its safe expiry path only when a queued job has never been leased or sent; otherwise it rechecks after 15 minutes rather than guessing.

Recovery is complete only when affected jobs are `succeeded` or safely `failed`, the active production pointer still identifies a healthy version, GroundX health is ready, and the incident is moved through `monitoring` to `resolved`. If a published copy is uncertain, do not publish or rollback again; wait for callback/reconciliation and preserve the prior pointer.
