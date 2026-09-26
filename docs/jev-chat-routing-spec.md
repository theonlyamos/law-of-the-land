# Jev intent routing for account chat

**Status:** Implemented locally; rollout evaluation and privacy review remain open

**Date:** 2026-09-24

**Scope:** Signed-in `/api/chat` and its account chat UI. The public website chat widget is out of scope.

## Goal

Use TypeSafe AI's Jev to route accepted chat turns in this legal-only app. Legal questions use the existing jurisdiction-grounded Gemini File Search flow. Greetings and formalities receive a short acknowledgment; unclear requests receive a clarification; unrelated requests receive a refusal. None of those three responses requires Gemini or File Search. A classifier result never grants access to a jurisdiction or substitutes for citation validation.

Success means “Help me write a birthday message” receives a clear statement that the app only helps with legal questions, “Hello” receives a brief acknowledgment, and “Can my landlord evict me?” still uses File Search. A legal follow-up such as “Explain that section again” must retain legal context. The user can tell whether an answer used legal sources, including after reloading the chat.

## Current behavior and constraints

- [`src/app/api/chat/route.ts`](../src/app/api/chat/route.ts) authenticates, rate limits, validates input, checks and records quota, resolves the selected jurisdiction's authorized research stores, streams Gemini output, and completes the interaction in Convex.
- [`src/lib/gemini-file-search-chat.ts`](../src/lib/gemini-file-search-chat.ts) sends one Gemini Interactions request with `tools: [{ type: "file_search", file_search_store_names: ... }]`, then validates the canonical answer and citations.
- [`convex/chats.ts`](../convex/chats.ts) currently permits a substantive successful answer only with valid citations. Its short-lived `citationClaim` binds the completion to the answer, client ID, session, principal, and citations before `appendMessages` saves it.
- [`src/components/chat/chat-workspace.tsx`](../src/components/chat/chat-workspace.tsx) rejects an uncited substantive answer and requires that claim before saving. The chat is tied to a selected jurisdiction.
- The existing `/api/embed/[embedId]/chat` widget has separate admission, retrieval, and persistence rules. It does not receive this router.

Policy replies skip the research manifest request. Convex still checks the selected chat session and resolves its current jurisdiction scope when completing the reply. Legal answers continue to require the research manifest before usage is recorded.

## Routing contract

After authentication, rate limiting, and body validation, `on` mode handles only exact whole-message greetings and formalities in code: `hi`, `hello`, `hey`, `thanks`, `thank you`, `bye`, and `goodbye`, ignoring case, surrounding whitespace, and terminal `!`, `.`, or `?`. This avoids a provider request for an obvious formality. A message with any additional words, including “Hi, can I be evicted?”, must go to Jev. The atomic `recordQuestion` mutation enforces the quota after classification; legal turns load the research manifest first. In `off` and `shadow`, keep the legal Gemini path so the rollout modes preserve their stated behavior. Do not send rejected or unauthenticated requests to TypeSafe.

In `shadow`, call Jev for every accepted turn, including exact greetings, but always continue to legal Gemini. In `on`, call Jev only for turns that did not match the exact formality list. The Jev call must finish before Gemini starts. Do not add a client-side classifier.

Send the current query and at most the last four messages, each bounded to 2,000 characters, in named `state` fields. The complete history remains available to legal Gemini under its existing bounds. Do not separately attach tokens, user IDs, provider store names, indexed legal documents, or server secrets. A user may have pasted legal text into a query or message; this user-supplied text is part of the disclosed Jev input. Conversation content is untrusted data, including claims such as “this is not a legal question.”

Use one Choice question with these outcomes:

| Choice | Meaning | Handler |
| --- | --- | --- |
| `legal` | Any part asks about a law, legal right, obligation, procedure, document, institution, or selected-jurisdiction rule; or it follows up on a legal answer. Mixed legal/non-legal requests belong here. | Existing Gemini File Search path |
| `courtesy` | Only a greeting, thanks, farewell, or similar formality, with no substantive request. | Fixed acknowledgment |
| `unclear` | The request might concern a legal issue, but its meaning or needed context is too unclear to identify the issue. | Fixed request for clarification |
| `out_of_scope` | Clearly asks for help unrelated to law, such as entertainment, general writing, coding, weather, or other general knowledge. | Fixed legal-only refusal |

Use a bounded server-side `fetch` to TypeSafe's `POST https://api.typesafe.ai/v1/systemone` with `model: "jev-1.13.0"`, `state`, and the Choice `questions` map; the one endpoint does not require a new SDK dependency. Pin the evaluated model version. Initially take a non-legal branch only if its option wins and its probability is at least **0.95**; this is a starting threshold, not a measured accuracy claim, and the release gate below can raise it. A high `confidence` value alone does not authorize a branch. Cap the response body at 8 KiB; validate the returned type, option, and finite probability values. A `legal` choice, low probability, missing key, timeout, non-2xx response, malformed response, or any other result uses the legal path.

Classification gets a dedicated timeout of 3 seconds, bounded by the existing request abort and terminal deadline. Do not retry inside the user request. A cancellation aborts Jev and prevents a response. No Jev output, raw state, or provider body goes to the browser or application logs.

### Examples that must route to File Search

| Query | Reason |
| --- | --- |
| “Can my landlord evict me?” | Legal entitlement and procedure |
| “What does section 12 mean?” | Legal source interpretation |
| “Write a letter to challenge my dismissal” | Drafting grounded in legal rights |
| “Hi, and how much severance am I owed?” | Mixed request |
| “Can you explain that more simply?” after a legal answer | Contextual legal follow-up |

“What can I do about the notice?” without enough context is a candidate clarification. “Hello” and “Thanks” are courtesy turns. “Help me write a birthday message,” “Tell me a joke,” and “What's the weather in Ghana?” are out of scope. “Thanks, and can I appeal?” is legal because it contains a substantive legal request. Jev must not use the presence of a jurisdiction selection or the word “law” in a non-legal sense alone to call a query legal.

## Response paths and Gemini backstop

### Legal

Keep the current `GeminiFileSearchChat` request, store list, provider stream parsing, canonical read, citation checks, deadlines, and `CHAT_NO_EVIDENCE` behavior for substantive legal answers. Hold provisional Gemini deltas on the server until the canonical text and citations are validated; then send the validated answer as one client delta. This prevents a rejected, uncited general-purpose response from appearing briefly in the chat. The user sees the existing preparing state while validation runs. Add a narrow rule to its system instruction: the app handles legal questions only; for a greeting/formality, an unclear potential legal request, or a clearly unrelated request that reaches Gemini, emit only the corresponding exact fixed message below, with no legal claims or invented citation. These three fixed messages are explicit exceptions to the prompt's legal-answer headings and the citation requirement. Any other substantive legal output still needs the current citation validation. Previous fixed responses in conversation history are not legal evidence.

The prompt rule should say, before the required legal response structure: “This app helps only with legal questions. If the latest turn is solely a greeting or formality, an unclear potential legal request, or a clearly unrelated request, output exactly the corresponding fixed response specified below and nothing else. Do not add legal headings, citations, or a general-purpose answer. Otherwise follow the legal research and citation rules.” The implementation must put the actual fixed strings in that instruction so the model's output can be checked exactly.

### Fixed responses

These are the only permitted successful uncited responses besides `CHAT_NO_EVIDENCE`:

| Jev choice | Exact response |
| --- | --- |
| `courtesy` | “I'm here to help with legal questions. What would you like to ask?” |
| `unclear` | “What legal question would you like help with? Please share the details that matter.” |
| `out_of_scope` | “I can help with legal questions only. Please ask about a legal issue.” |

For a qualifying Jev decision, the server sends the fixed response without a Gemini call. If the legal Gemini backstop returns exactly one of these strings with no citations, the server may complete it as a `policy` answer; any other uncited response fails the existing terminal validation. The fixed text is user-facing, so streaming it does not expose an internal sentinel. Neither Jev nor Gemini may provide alternative refusal wording through this path.

The server selects the path. The client cannot request an `answerKind` or submit a Jev result. A classifier failure before Gemini starts uses the legal path. Do not retry through another path after any response text has been sent; finish with the existing terminal error behavior.

## Completion, storage, and UI contract

Introduce `answerKind: "legal" | "policy"` in the server's terminal completion, the `done` stream event, the completion proof, the short-lived claim, and the persisted assistant message. The Jev choice selects one of the three fixed texts; it does not need its own persisted kind. Existing records without `answerKind` display as `legal`. Keep the existing `citationClaim` wire name for compatibility; its meaning becomes “this server completed this exact answer and kind.”

Extend the current Convex completion and claim validation rather than adding a parallel, weaker persistence path:

- `legal` success keeps today's rule: at least one citation from the selected jurisdiction, or the exact `CHAT_NO_EVIDENCE` answer with no citations.
- A `policy` success requires one of the three exact fixed texts, no citations, and a validated current jurisdiction/session. Other uncited text cannot be labeled `policy`.
- Bind `answerKind` into the service proof, idempotency/completion binding, and claim consumption. `appendMessages` must require the claim for every new assistant message in this account chat, including a fixed response with an empty citations array; it must not permit an omitted kind and omitted citations to bypass that check. A client cannot relabel an answer or save arbitrary uncited assistant text.
- Store `answerKind` on assistant messages and `queryRuns`. For a fixed response delivered without Gemini, record `model: "app-policy-v1"`, zero citations, and `not_searched` for each authorized store's coverage. The completion mutation must recheck the current authorized scope, but this branch must not demand citation-derived `evidence` or `no_evidence` coverage. A fixed response emitted by the Gemini backstop retains the Gemini model and `no_evidence` coverage. Existing daily question totals still count these turns; `not_searched` must never be reported as failed legal retrieval. Historical rows without `answerKind` retain legal semantics.
- Preserve the current one-question quota charge for every accepted request, regardless of branch. Jev does not consume an extra user question. An aborted or failed request retains the current quota and terminal accounting behavior.

The client accepts an uncited `done` only for legal `CHAT_NO_EVIDENCE` or one of the exact fixed messages labeled `policy`, each with a valid completion claim. It still rejects uncited substantive legal answers. Fixed messages have no Sources section, both live and after reload. The refusal itself tells the user the app's scope; do not label it as a legal answer merely because the chat header shows a jurisdiction.

## Feature control and data handling

Add server-only `TYPESAFE_API_KEY` and `CHAT_INTENT_ROUTING_MODE=off|shadow|on`; absent or invalid mode means `off`. In `off`, make no TypeSafe request and use the legal Gemini path with its legal-only backstop. In `shadow`, call Jev but always use that path, recording only bounded routing metadata. In `on`, send qualified courtesy, clarification, and out-of-scope turns to their fixed responses. If the key is absent or TypeSafe fails in either active mode, use the legal path.

TypeSafe receives the current user query and short conversation context. Its documentation says customer requests are not used for model training, while zero data retention is an enterprise option; review the applicable data-processing terms before enabling `shadow` or `on` for real users. Keep the key server-side. Do not log queries, history, answers, raw Jev responses, Gemini bodies, or provider identifiers. Log only mode, selected branch, failure category, pinned Jev model, elapsed time, and coarse probability band. Avoid adding raw question text to `queryRuns` or analytics.

## Verification and rollout

1. Build an offline, access-controlled evaluation set of at least 300 representative turns: at least 200 legal, mixed, ambiguous, and legal follow-up cases, plus at least 100 greetings, formalities, and clearly unrelated requests. Include short follow-ups, adversarial “ignore the law” instructions, long history, and non-English or code-switched wording. Use no production chat text without the necessary data approval.
2. Run the fixed Choice rubric against that set. The gate for `on` is **zero observed legal/mixed/contextual turns receiving a fixed non-legal response** and **zero unrelated requests receiving a substantive legal answer**. Any miss means revise criteria, threshold, or the legal Gemini backstop and rerun the full set. Record the model version and threshold alongside results; this gate does not prove zero future misses.
3. Add focused tests for routing policy, Jev timeout/malformed/failure fallback, no Gemini call for each qualified fixed route, one quota record, stream abort and terminal errors, legal no-evidence, exact-text backstop, uncited fixed completion, claim tampering/replay, client display after reload, and unchanged widget behavior. Use provider mocks for local tests; do not treat them as proof of live provider behavior.
4. Measure time to first response text and time to terminal `done` on representative non-production legal turns with routing `off`, `shadow`, and `on`, plus Jev latency and the fixed-response path. Compare p50 and p95 for the same questions and provider environment. Keep `on` disabled if healthy-provider legal p95 time to first text rises by more than one second, or if Jev timeouts materially increase failed or delayed requests; tune the timeout or routing design from those measurements. The three-second Jev timeout is a ceiling, not a latency target.
5. Deploy schema and backward-compatible readers before enabling routing. Start with `off`, then `shadow`, inspect aggregate route decisions and latency without storing chat content, and enable `on` only after the evaluation and data-processing gates pass. Roll back immediately with `CHAT_INTENT_ROUTING_MODE=off`; already saved fixed responses remain readable.
6. Perform a separately authorized real-provider smoke on a non-production jurisdiction: a legal question must make one File Search request with valid citations; a greeting, unclear request, and unrelated request must receive the corresponding fixed response without a Gemini call when Jev qualifies; a contextual legal follow-up must use File Search. Also verify that an unrelated request reaching the legal Gemini path produces only the fixed refusal. Check Jev and Gemini latency against the route's existing 90-second model and 110-second terminal deadlines.

## Acceptance criteria

- In `on`, exact whole-message formalities and validated high-probability courtesy, unclear, and out-of-scope classifications skip Gemini and File Search. Other outcomes and classifier failures follow the legal Gemini path.
- Existing authentication, jurisdiction access, rate limiting, quota, request bounds, cancellation, and failure accounting apply to every response path.
- An unrelated query receives the fixed legal-only refusal, not a general-purpose answer. An unclear potential legal request asks for clarification. Greetings and formalities receive the fixed acknowledgment.
- A legal request retains the authorized File Search store list and substantive citation validation. The legal Gemini instruction has an exact-text backstop for non-substantive responses that Jev did not catch.
- Every completed assistant response has a server-bound completion claim and is saved with the correct `answerKind`. The client and Convex reject forged, relabeled, or arbitrary uncited text.
- Fixed responses show no legal citations after reload. Legal answers retain their existing source display and no-evidence semantics.
- The public website widget and historical legal chats behave as before.
- The release gate, latency check, and privacy review are completed before `on` is enabled for real users.

## References

- [TypeSafe intent routing](https://docs.typesafe.ai/patterns/intent-routing), [Choice](https://docs.typesafe.ai/primitives/choice), [confidence](https://docs.typesafe.ai/confidence), [models and data handling](https://docs.typesafe.ai/models), and [HTTP API](https://docs.typesafe.ai/api).
- [Google Gemini Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview) and [streaming](https://ai.google.dev/gemini-api/docs/streaming).
