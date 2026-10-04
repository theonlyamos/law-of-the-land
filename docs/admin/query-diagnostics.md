# Governed query diagnostics

Authenticated `/api/chat` requests can attach an optional version 1 diagnostic
object to the existing governed completion. The object is stored on `queryRuns`,
bound into the server service proof and completion replay identity, and excluded
from browser events and citation claims. Existing requests without diagnostics
retain their previous proof and replay serialization.

The optional `structure` extension adds a separately versioned proof suffix only
when present. Older version 1 diagnostic objects retain their exact serialization,
so an older route can complete requests while the updated backend is deployed.

Diagnostics contain closed phase/reason labels, integer counters from 0 to 1024,
and structural flags. They never contain questions, answers, snippets, provider
payloads, raw errors, provider interaction IDs, document/store names or credentials.
Counters saturate at 1024 and set `countsClamped`; a saturated count is not exact.

## Interpretation

- `phase` identifies generation, canonical read or completion. The route labels a
  deadline or client cancellation explicitly even if a provider request is pending.
- Local parser rejections retain their closed reason. Native provider exceptions
  use `provider_request_failed`; provider SSE error events use `provider_error`.
  A missing provider API configuration uses `not_configured` before any request.
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
  The three metadata flags describe the identity values supplied to validation;
  normalization failure can make all three false. They do not assert authorization.
  The rejected annotation's structural shape records original field presence.
- `no_canonical_annotations` identifies the existing legal abstention branch. Zero
  counts never independently establish that a published source is missing, that
  retrieval was empty, or that the model lacked relevant material.

## Structural extension

`structure` compares three annotation carriers: streamed annotation deltas and
initial model-output text blocks,
canonical model-output text blocks, and model-output text blocks included in the
`interaction.completed` event. Each carrier has fixed annotation-kind counters
and, when observed, the shape of its first annotation. `completionStepsPresent`
distinguishes a completion event that supplies a steps array from one that omits it.
These observations do not grant authority to use streamed or completion-event
annotations as citations.

Kinds are `file_citation`, `url_citation`, `place_citation`, `word_info`,
`speech_metadata`, `missing_type`, `unknown_type` and `malformed`. Arbitrary
provider discriminator strings are never stored. Counts describe observations,
not unique citations. The structural stream counts include initial text blocks,
while the original `streamedAnnotationCount` counts only annotation deltas.
A first annotation's shape does not describe every annotation
in that carrier.

`rejectedCanonicalAnnotation` records the inspected annotation's shape before the
existing citation checks reject it. Shape fields classify the metadata container,
document URI and file name, and expose booleans for known identity fields, file-name
and source presence, and duplicate identity metadata keys. Object metadata and the
documented array form `{ key, string_value }` are inspected only for these flags;
they are not normalized into accepted citations. Authorized URI categories mean
only that a value has the expected syntax under a currently supplied store. They
do not prove that the document or metadata is authorized.

Offset and page categories distinguish missing, incomplete, malformed and valid
numeric shapes without retaining numbers. A valid offset pair means safe integers
in nondecreasing order with a nonnegative start. It does not establish the provider's
offset coordinate frame. `offsetsWithinAnswer`, when supplied with a full canonical
answer, checks only the current byte-length bound.

`rejectedStreamAnnotation` uses the same closed shape when an authenticated-chat
stream citation fails validation. Its proof suffix is added only when present;
existing structural diagnostic proofs remain unchanged when it is absent.

## Verified final stream batch

### Bounded stream reconnection

If a stream iterator ends before an accepted `interaction.completed`, the adapter
may make one streaming GET for the same interaction using the `event_id` on the
last accepted event as `last_event_id`. A missing or invalid cursor on that last
event prevents reconnection; an older cursor is not used because it could replay
already applied events. Payload event IDs remain only in request memory and are
never diagnostic values. Malformed streams, explicit provider errors, aborts and
deadlines are not retried by this path.

The resumed stream retains the original steps, search call IDs, answer bytes and
citation batches. Its GET uses the existing stream signal/deadline and disables
SDK HTTP retries. It cannot increase the twenty-call allowance, reset a bound, or
accept duplicate steps or search calls. A valid same-ID terminal event, closed steps, canonical
GET and exact whole-answer agreement remain mandatory before citation validation.
Repeated premature EOF still fails closed; no replacement interaction is created.

The [API reference](https://ai.google.dev/api/interactions-api#getinteractionbyid)
defines resume as starting after the supplied event. Google's continued-execution
guarantee after disconnect is documented for background execution. These requests
remain in their existing foreground mode, so reconnection is a bounded retrieval
attempt rather than a guarantee that interrupted generation will finish.

### Citation batch validation

Authenticated chat can retain the final annotation-array batch when the canonical
GET contains no File Citations. This addresses the observed EAC mismatch: File
Citations appeared during streaming, while the canonical response retained only
URL citations. The route opts in on the server; guest and embedded routes retain
their existing behavior.

The fallback requires completed matching interaction IDs, exact whole-text
agreement, and supported text content. Gemini can emit its final File Citations in
an annotation-only model-output step after the answer text. That empty carrier is
part of the same completed response; it does not have to repeat the answer.
Canonical content-block and step boundaries need not match the stream's text
partitions. The complete assembled text must still match exactly.

Every annotation event replaces the retained batch. An initial model-output
snapshot combines its annotated text blocks into one bounded batch before
replacement, so later blocks in that same snapshot do not erase earlier ones.
A later empty or URL-only
batch cannot restore an earlier File Citation. Missing or malformed arrays and
exceeded observation bounds fail closed. The final batch is a conservative subset
if provider arrays are additive, or the latest state if they replace; this does not
establish complete citation coverage.

Each admitted File Citation must supply complete, unique jurisdiction/resource/
version metadata and a reference to an authorized store. A store URI uses the same
catalog identity contract as canonical File Citations. An exact provider document
resource, when supplied, is additionally proof-bound and must equal the current
published version's catalog name. Conflicting or malformed document references are
rejected. Current access, active-version, store, publication and lifecycle-lock
checks still apply. Missing identity fields, display names and URL citations cannot
supply document authority. Answer text is sent only after authoritative completion.

Streamed citation locators must be nonempty paired ranges within the complete
answer's UTF-8 byte length and code-point boundaries. They are never rebased.
These are bounded source-provenance checks; only document/page citations are
exposed, with no claim of precise inline span attribution.

The [Interactions API reference](https://ai.google.dev/api/interactions-api)
describes File Citation offsets as byte positions in the response. It does not
establish step-local offsets. The
[streaming guide](https://ai.google.dev/gemini-api/docs/streaming) describes step
assembly without guaranteeing that a later GET preserves text partitions.

`stream_citation_batch`, `stream_citation_limit` and `stream_citation_ambiguous`
identify malformed batches, observation bounds and unsupported output content.
Historical `stream_citation_ambiguous` rows also include the former empty-owner
and per-step text-partition guards; that reason alone cannot distinguish them.
The application search-call guard now distinguishes `file_search_call_id`,
`file_search_call_duplicate` and `file_search_budget_exhausted`. The per-answer cap
is twenty calls, shared across any stream reconnection. The interaction-step
allowance accommodates forty search call/result steps plus sixteen other steps,
with an independent maximum of thirty-two non-search steps. Output-block, byte,
annotation, time and token limits remain unchanged. Historical `file_search_call`
rows cannot identify which of the combined conditions rejected the candidate.
Interactions exposes no supported provider-side File Search iteration limit;
SDK automatic-function-calling limits apply to a different API path.

Authenticated chat exposes `file_search_budget_exhausted` as an allowlisted
public error reason as soon as the guard rejects the next call. Its explanation
does not wait for bounded failure telemetry to finish. The failed answer is not
released, and the composer explains that the limit applies to each answer and
suggests a narrower question or a new chat. Sending another question clears the
notice; failed local turns are excluded from subsequent model history. This is
not a persistent account quota, so there is no reset timer or permanent input
lock. Confirmed timeouts also expose the closed `deadline_exceeded` reason with
guidance that the answer took too long and could not be verified. The user can
ask a more focused question or try later; the app does not retry automatically
or promise that either action will succeed. Both actionable errors are sent
before bounded failure persistence. Other internal reasons remain private.

Research instructions prioritize the requested instrument or provision, treat
roughly three focused searches as planning guidance, and stop when retrieved
evidence answers the question. They also state the enforced twenty-call limit and
require final output after the last permitted result, without another search.
They preserve material conditions, evidence-gap handling and abstention and do not
require extra research merely to fill the response headings. This guidance does
not guarantee completion within the twenty-call cap or establish why a previous
request exhausted its search budget.

Answer instructions reserve PDF page numbers for the application Sources
presentation when citation metadata supplies them. Sources has no separate
printed-page field, so prose may retain a printed-page label explicitly exposed
for the cited passage in retrieved text, identified as a printed page and never
inferred or converted from a PDF page number. Opaque provider reference markers such as `[1.2]` and
`[1.7-1.8]` are prohibited. Verified article/section references and exact supporting
excerpts remain appropriate. This is generation guidance, not a deterministic
prose validator. The application does not alter trusted provider page values,
rewrite canonical text, or strip bracketed legal references with regular
expressions.

`fileSearchResultDeltas` counts observed result-delta payloads as missing, empty
arrays, nonempty arrays or other shapes. An absent result delta or result field
does not prove that File Search retrieved nothing.

All structural counters and scans are bounded. Saturation or truncated observation
sets `countsClamped`. No new fields contain prompt text, answers, snippets, raw
provider types, metadata values, names, URLs, identifiers, offsets or credentials.

## Deployment and investigation

### Execution observations

The optional `execution` object contains only seven booleans and two closed
labels. It adds a separate versioned service-proof suffix when present; absent
execution data preserves existing proofs and completion replay identities.

- `modelDeadlineReached` and `terminalDeadlineReached` record application
  deadline signals or a route/adapter deadline guard. `clientAbortObserved` records
  client cancellation. These independent flags may coexist; they do not assert
  which simultaneous condition caused the provider to stop.
- `streamAbortObserved` records a local stream cancellation or a provider/SDK
  abort observed at the streaming boundary. `providerFailure` is `none`,
  `timeout`, `abort`, or `other`. Exceptions from an actual SDK request or
  iterator read and supported SSE error envelopes receive a provider label;
  application validation and callbacks do not. Local signal cancellation does
  not become a provider timeout. Classification examines bounded status, code,
  name, and message values without storing them. A provider timeout label means
  a timeout-shaped SDK exception or SSE error envelope, not proof
  of a remote service outage.
- `completionEventAccepted` becomes true after the terminal event passes the
  existing identity/status/open-step checks. It does not imply canonical or
  catalog validation. `streamClosed` means the current stream iterator reached
  clean EOF, and resets when a same-interaction resume starts. A completion event
  followed by a stalled iterator can therefore be distinguished from a stream
  that never supplied an accepted completion.
- `resumeAttempted` records the existing single bounded same-ID GET.
  `resumeOutcome` is `not_attempted`, `pending`, `completed`, `incomplete`,
  `failed`, or `aborted`. Completion here requires accepted terminal state plus
  clean EOF; later canonical failure does not erase that observation. These
  fields do not add retries or change the cursor, deadline, or search limits.

Failure snapshots are taken before cleanup and before sending a terminal public
error, so the reader cancelling after that error cannot rewrite the original
cause. Diagnostics are private in persisted query runs and the bounded server
failure summary; they do not appear in public answer/citation events. If the
110-second terminal deadline expires, no additional persistence allowance is
created: the server summary may be the only final observation. Existing rows
without `execution` cannot retrospectively identify these distinctions.

### Representative validation

Lifecycle fixtures cover the observed 8-, 14-, and 16-search timeout shapes,
provider timeout/abort, accepted completion followed by a stalled stream, and
same-ID recovery outcomes. They establish state handling and authorization
invariants, not live retrieval latency. The current DEV Ghana corpus has one
published resource while production has 101; a local DEV success is only a smoke
test. Use the existing authenticated production app for one coordinated real
corpus observation after release. Reproducing that corpus locally requires a
separate decision about approved source uploads/indexing or a normally authorized
candidate environment; never substitute store IDs or move credentials to bypass
the deployment's session and catalog authorization.

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
