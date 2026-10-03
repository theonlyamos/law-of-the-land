# Governed query diagnostics

Authenticated `/api/chat` requests can attach an optional version 1 diagnostic
object to the existing governed completion. The object is stored on `queryRuns`,
bound into the server service proof and completion replay identity, and excluded
from browser events and citation claims. Existing requests without diagnostics
retain their previous proof and replay serialization.

Diagnostics contain closed phase/reason labels, integer counters from 0 to 1024,
and structural flags. They never contain questions, answers, snippets, provider
payloads, raw errors, provider interaction IDs, document/store names or credentials.
Counters saturate at 1024 and set `countsClamped`; a saturated count is not exact.

## Interpretation

- `phase` identifies generation, canonical read or completion. The route labels a
  deadline or client cancellation explicitly even if a provider request is pending.
- Local parser rejections retain their closed reason. Native provider exceptions
  use `provider_request_failed`; provider SSE error events use `provider_error`.
  An exception message that resembles an application code is not trusted.
- `searchCallCount` and `searchResultCount` count accepted streamed call/result
  step starts. `searchResultItemCount` sums entries observed in supported
  `file_search_result` deltas; it is not a unique document/hit count.
- `streamedAnnotationCount` counts annotations observed in streamed annotation
  deltas. `canonicalAnnotationCount` counts annotations encountered in canonical
  model-output text blocks. Neither counter changes citation validation.
- `canonicalReadCompleted` means the canonical GET returned, not that the returned
  interaction passed validation. Counts before a failure describe partial progress.
- `citationUriKind` describes the most recently inspected citation as missing,
  an authorized store URI, a document URI under an authorized store, or other.
  The three metadata flags indicate valid bounded identity strings were present;
  they do not assert that those identities passed authorization.
- `no_canonical_annotations` identifies the existing legal abstention branch. Zero
  counts never independently establish that a published source is missing, that
  retrieval was empty, or that the model lacked relevant material.

## Deployment and investigation

The optional Convex schema/function contract must be deployed before the route
sends the new argument. The documented Vercel main build runs
`npx convex deploy --cmd 'bun run build'`; its command must finish the Convex push
before Vercel activates the frontend. Verify the exact backend deployment revision
and frontend readiness before asking the browser operator to reproduce.

Coordinate one controlled reproduction per observed outcome category with the
browser operator: validation failure, legal abstention and timeout. Record the
conversation identifier and UTC interval, then read only bounded projections of
the corresponding query rows. Do not send duplicate requests from another browser.

Use the observed reason and structural fields to construct a sanitized regression
fixture and fix the confirmed boundary. Preserve jurisdiction/document authority,
canonical output agreement and fail-closed citation checks. Do not infer a specific
provider failure from the broad legacy `validation` category alone.
