# Citation source previews

Click a source in a saved answer to open an in-app original-PDF preview. The preview navigates to the cited PDF page, supports page and passage navigation, fit-width/zoom controls, and offers a separately reauthorized full-document link. An accessible extracted-text view accompanies the page canvas.

## Evidence and fallbacks

- A highlight means an exact, uniquely located match to a saved source excerpt. It does not assert sentence-by-sentence claim alignment.
- Only whitespace and common typographic ligatures are normalized. Case, punctuation, wording, and hyphens remain exact. No question-keyword, fuzzy, or semantic matching is used.
- Duplicate matches, mismatched text, missing text layers, and out-of-range pages are explicitly reported. Scanned pages remain viewable without fabricated highlights. No OCR service or new provider call is introduced.
- Current Gemini File Search citations provide document/page identity and answer offsets; their `source` field is not a guaranteed quotation. These citations therefore produce page-only previews.
- The reviewed-employment path has integrity-checked original source excerpts. Only after the existing answer verification succeeds are these excerpts included in signed completion provenance. Existing answers without saved excerpts remain page-only.
- Truly old citations without a document snapshot show an unavailable-preview explanation. Public guest-source links remain available as source-website links; arbitrary external documents are not embedded or proxied.

## Access and integrity

Citation provenance is an optional additive field on completion claims and saved messages. It includes document/version identity, provider linkage, expected original hash/size, optional PDF page, and optional exact excerpts. The source snapshot is written by the proof-validated completion path and copied only while consuming its single-use claim. Public append inputs cannot supply it.

Both original-file resolvers require a short-lived server HMAC capability, using the existing `TELEMETRY_INGEST_SECRET`. The browser receives only the same-origin `/api/chat/sources/{messageId}/{citationIndex}?chat=...` proxy path, never a raw storage URL or server proof. Every file request checks current login, answer ownership, source permissions, publication/version, lifecycle, and original storage integrity. The reviewed-source resolver retains its stricter existing pinned-edition/date/page policy.

The proxy is private/no-store, accepts only allowed Convex storage origins, does not follow redirects, and preserves PDF range responses. The preview accepts only validated private proxy URLs, caps its response at 32 MiB, and destroys its worker/render tasks on close or source changes. The PDF.js worker is bundled locally, not loaded from a CDN. The dev/build scripts prepare versioned local CMaps, standard fonts, and decoder assets from the pinned package. PDF scripting and interactive annotation rendering are not initialized.

## Verification

Focused unit/integration tests cover exact matching and ambiguity, source access and tampering, old data, private proxy responses, UI errors, and keyboard lifecycle. Run the normal suite and compilation checks:

    bun run test
    bunx tsc --noEmit
    bun run lint
    bun run build

The repository’s current ESLint configuration does not lint TypeScript/TSX; a green configured lint command is not a full frontend lint check.

An isolated Vite/Playwright fixture harness lives in `e2e/citation-preview/`. It uses synthetic PDF bytes and no backend, provider calls, or real user data. See its README for the standalone command and browser requirements.

## Release considerations

The change is prepared locally; it does not publish, deploy, or backfill existing answers. Backend schema/functions and the Next source proxy must be released together because the original-file actions now require the server capability. The existing service secret must be configured on both trusted server runtimes. No new credential is needed. Do not enable reviewed-answer provider execution merely to test this UI.

## Local verification record (2026-10-11)

- Complete Vitest suite: 190 files, 3,417 tests passed.
- TypeScript no-emit check and Next production build: passed.
- Configured ESLint command: passed, with the TypeScript coverage caveat above. Generated third-party PDF assets and fixture bundles are excluded.
- Isolated Vite fixture production build: passed. All 12 Playwright browser cases passed in cloud Chromium, including focus containment/restoration, page and passage navigation, zoom, mobile layout, scans, ambiguity, authorization failures, and rotated-page geometry.
- Desktop, mobile, and rotated-page screenshots were visually inspected; highlights align with the original fixture text.
- Independent code/security review: no remaining blocking findings after correcting raw-storage capability exposure and rotated text-layer geometry.
- The command executor initially could not launch Chromium (socket EPERM), including an approved escalation. Browser QA subsequently ran successfully from the same cloud computer’s supported desktop terminal, without changing security/network settings, exposing a tunnel, or using the user’s computer.
- Authenticated full-stack runtime QA remains unverified: no live Convex deployment or provider invocation was used.
