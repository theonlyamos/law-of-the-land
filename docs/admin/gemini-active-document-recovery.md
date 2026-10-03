# Reconcile an active document with a pending upload operation

`admin/geminiRecoveryActions:reconcileActiveDocument` is an internal deployment-admin action for one retained **first-publication** job. It is separate from Retry safely, which continues polling the original operation. It never uploads, downloads the original file, deletes a provider document, or publishes other approved versions.

Deploy and invoke this action only after approval of the reviewed change and the specific production recovery. Local implementation or a prior diagnostic approval does not authorize production recovery. Do not invoke the internal claim/completion/abort mutations manually or supply a fabricated provider result.

The action accepts `jobId`, an audit `reason`, and an `idempotencyKey`. Provider credentials are read only from the existing backend environment. No provider names, credentials, lease values, or client-supplied evidence belong in the invocation.

For the diagnosed OHADA job, after deployment and execution are approved:

```powershell
$recoveryArgs = @{
  jobId = 'm572hc94dkzn1ckbe39p22p2tn8fgmea'
  reason = 'Reconcile the unique active document with the retained first publication'
  idempotencyKey = 'ohada-active-document-recovery-2026-10-03'
} | ConvertTo-Json -Compress
bunx convex run --deployment loyal-koala-720 --codegen disable admin/geminiRecoveryActions:reconcileActiveDocument $recoveryArgs
```

## Eligibility and verification

- The job must be `manual_review`, `gemini_index_document`, and `poll_operation`, with its retained same-store operation and original `publish` payload. No previous/active version or existing version document reference is allowed.
- The admin environment gate and original publisher's current account/permission checks must pass. A platform job requires the publisher's current platform `document.publish` permission, including when the jurisdiction belongs to an organization. An organization-scoped job requires the same organization and current organization review authority; platform permission cannot replace that binding. Active resource, enabled jurisdiction, unique store ownership, absence of teardown, and original stored-file size/SHA are revalidated.
- The action claims the normal job lease and jurisdiction execution permit without scheduling the polling runner. Its receipt binds the attempt to the target and lifecycle lock.
- Provider verification uses GET requests only: pending-operation read, complete scan of at most 20 pages of 20 documents, direct GET of the unique exact six-field metadata match, and another pending-operation read. The matching list entry and direct GET must both be ACTIVE. Missing, malformed, duplicate, conflicting, or incomplete observations fail closed.
- Completion rejects stale evidence, changed bindings, expired leases, and lock/authority changes. It atomically reuses normal first-publication completion, job success, counts/catalog updates, lock/permit release, and audit. Other unresolved jobs can keep the jurisdiction drifted.

## Results and failure handling

The response contains only `status`, `jobId`, and `correlationId`. A successful repeat with the same key and reason returns the existing result without another provider read or publication. Reusing a key for different input is rejected; an in-progress receipt is reported as in progress.

Failed verification restores only the owned attempt to manual review, releases only its matching permit, records a failed receipt, and preserves the original operation, poll counters, publication state, and lifecycle lock. Retrying a failed receipt with the same key returns that failure. A new attempt requires a deliberately new key and fresh verification.

If execution stops before cleanup, the existing stale-job maintenance handles the expired lease. Inspect the job/receipt before deciding on another attempt; do not force readiness or clear the lock. A successful recovery does not authorize publishing any other held versions.
