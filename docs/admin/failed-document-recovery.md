# Failed Gemini document recovery

This recovery excludes an unpublished first-publication version when Gemini's
document is `STATE_FAILED` while its retained upload operation remains pending.
It does not publish that version or submit another upload. Gemini does not return
the processing cause in this state, so the recorded summary keeps the cause
unknown. A failed document is not assumed to remain failed forever.

## Release and retrieval acceptance gate

Do not run a production restore until the complete backend and application change
has been reviewed, deployment has been explicitly approved, and the published
metadata filter has passed live provider acceptance. Offline tests and the SDK's
`metadata_filter` type alone do not establish live filter semantics. The local
implementation and its offline checks perform no provider calls or deployment.

The live acceptance must use the normal capable application request builder and
its exact server-derived published allowlist. Verify positive retrieval from an
allowed published document and negative retrieval from a known unlisted ACTIVE
document in an approved isolated corpus. That negative source must be retrievable
in an unfiltered control; a currently FAILED source cannot establish that the
filter excludes it after it becomes ACTIVE. Inspect provider grounding evidence
and ensure the unlisted identity is absent. Do not rely on citation rejection
after retrieval. Do not create or delete production provider documents for this
check. Live calls and any isolated fixture setup require their own authorization.

For the affected jurisdiction, review that the final allowlist contains exactly
its existing published ACTIVE sources, excludes each failed version, and is
carried in every supported File Search request. Older consumers without the
`published-v1` capability must be denied. The legacy embedded consumer remains
unavailable for a restricted store. Record acceptance before the first invocation
that can change `providerSyncState` to `synced`.

## Preconditions and supported invocation

Use the authenticated deployment-admin internal action
`admin/geminiFailedRecoveryActions:reconcileFailedDocument` with a job ID, a
meaningful audit reason, and a new bounded idempotency key. This action uses the
backend's existing Google configuration. Never copy its key to a shell, browser,
manual HTTP request, or document. Do not invoke the completion mutation directly
or supply a hand-crafted provider proof.

Only a retained first-publication job in `manual_review` is eligible. Replacement
and rollback failures remain held for their separately reviewed lifecycle recovery.
The original publisher must still have publication authority, verified email, and
two-factor authentication enabled;
the original stored bytes must match the recorded size and SHA. The version,
resource, owned lifecycle lock, current store, organization scope, and execution
permit are checked before the action claims a dedicated recovery lease. Generic
polling and safe retry remain denied for detector-confirmed failed evidence.

The verifier performs bounded GET requests only: pending operation checks before,
between, and after two complete provider inventory scans, plus direct GETs of
every expected document. Each inventory must exactly match six metadata fields
(`environment`, `jurisdiction_id`, `resource_id`, `version_id`, `version_number`,
`sha256`). Published entries must uniquely match their recorded document names
and be ACTIVE; excluded entries must uniquely match FAILED documents. Extra,
duplicate, missing, pending, ambiguous, changing, or untracked entries fail closed.
The proof must be less than 30 seconds old at guarded completion.

A previous matching durable failed-document observation must be at least five
minutes old. Without it, the first invocation records the candidate and returns a
failed receipt while leaving the job in review, its lifecycle lock held, and
search paused. Do not sleep inside an action. After the interval, explicitly run
the action with a new idempotency key and fresh complete coverage proof. Reusing
the same completed key returns its recorded receipt without another provider
read. Reusing a key for a different reason or job is rejected.

## Result and preserved safeguards

Guarded completion rechecks the entire bounded database snapshot, original
publisher authority, lease, permit, and exact provider identity. It marks only
the targeted job and version failed, releases only that job's lifecycle lock,
and keeps the upload operation, publication payload, original error classification,
poll count, and bounded hashed evidence. The resource receives a persistent
publication block, so a replacement version or rollback cannot upload again.
Late runner callbacks cannot publish through an expired or completed lease.

The transaction installs a sticky `published_only` search restriction. Search
can become synced only when the complete ACTIVE published coverage has just been
proved, the allowlist is valid and bounded, and no other unresolved job or
lifecycle lock remains. Reconciling the first of several affected publications
keeps the jurisdiction drifted. Subsequent recovery includes earlier failed
tombstones and newly confirms their exact FAILED state.

Normal raw provider response retention still expires. The durable failure
evidence, operation reference, bounded payload, resource block, and jurisdiction
restriction survive terminal-job retention. Do not clear the block or restriction,
force a synced state, resubmit, delete provider documents, or remove the tombstone
to make publication appear successful. A later transition or provider explanation
requires a separately reviewed recovery. A verifier error cleans up only its
claimed lease and permit; it does not release the publication lock or restore
search. No automatic retry or upload is scheduled by this action.

## Evidence to record

Record the internal receipt ID/correlation, timestamps of the separated
observations, published coverage count, app job/version states, and the sanitized
provider state. Keep credential values and raw provider response bodies out of
reports. A FAILED provider document plus a pending operation establishes that
provider processing failed without finishing the operation; it does not establish
why processing failed or that the PDF was invalid.
