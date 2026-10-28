# Finish a publication whose failed document later became active

`admin/geminiRecoveryActions:reconcileRecoveredDocument` is an internal deployment-admin action for one retained **first-publication** job that was held because Gemini reported its document as `STATE_FAILED`, and that Gemini later processed successfully.

Use it when all of these are true:

- The job is `manual_review` with failed-document evidence that has not been reconciled (no `coverageVerifiedAt`), so the version is still `publishing`.
- A read-only `admin/geminiDiagnosticActions:inspectIndexJob` shows the upload operation is done with no error and the matching document is now `STATE_ACTIVE`.
- [Failed-document recovery](failed-document-recovery.md) refuses, because it needs the document still FAILED and the operation still pending.

Neither the ordinary poller nor [active-document recovery](gemini-active-document-recovery.md) can finish such a job: both refuse jobs that carry failed-document evidence.

Deploy and invoke this action only after approval of the reviewed change and the specific production recovery. Do not invoke the internal claim/completion/abort mutations manually or supply a fabricated provider result.

The action accepts `jobId`, an audit `reason`, and an `idempotencyKey`, for example from the Convex dashboard (Functions, then Run) or:

```powershell
$recoveryArgs = @{
  jobId = '<integrationJobs id>'
  reason = 'Gemini made the once-failed first publication active; finish the retained job'
  idempotencyKey = '<new unique key>'
} | ConvertTo-Json -Compress
bunx convex run --deployment loyal-koala-720 --codegen disable admin/geminiRecoveryActions:reconcileRecoveredDocument $recoveryArgs
```

## Eligibility and verification

- The same job, payload, lock, publisher-authority, store-ownership and original-file checks as active-document recovery apply, plus: the evidence's operation reference must match the retained operation, and its document reference must be a well-formed hash.
- The action takes its own lease and the jurisdiction execution permit. It does not schedule the polling runner.
- Provider verification uses GET requests only: an operation read that must be `done: true` with no error and a `response.documentName`; that name must hash to the evidence's document reference, so it is the same document that was confirmed failed; a complete scan of at most 20 pages of 20 documents, which must find it as the unique exact six-field metadata match and `STATE_ACTIVE`; a direct GET that must agree; and a final operation read that must still name the same document.
- Completion rejects stale proof (older than 30 seconds), changed bindings or evidence, expired leases and lost authority. It then applies the normal first-publication completion (version published, resource catalogued, lock released, counts and audit), marks the job succeeded, and removes the failed-document tombstone because the provider operation is no longer unresolved. The jurisdiction returns to `synced` only when no other provider job for it is unresolved and it has no published-only restriction.

## Results and failure handling

The response contains only `status`, `jobId`, and `correlationId`. Repeating a request with the same key and reason returns the saved result without another provider read. Reusing a key with a different reason is rejected.

A failed verification restores only the claimed attempt to manual review, releases only its permit, and records a failed receipt. The evidence, operation, publication state and lifecycle lock are unchanged. A new attempt needs a new key.
