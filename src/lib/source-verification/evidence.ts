import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { z } from "zod";

/** Evaluation-only bounds. Draft/verdict/transport bounds are consumed by later stages. */
export const EVALUATION_LIMITS = Object.freeze({
  maxSourceVersions: 8,
  maxPages: 24,
  maxEvidenceTextBytes: 64 * 1024,
  maxQuestionFactsDraftBytes: 32 * 1024,
  maxSegments: 64,
  maxClaims: 64,
  maxEvidenceReferencesPerClaim: 8,
  maxSerializedInputBytes: 128 * 1024,
  maxResponseJsonBytes: 64 * 1024,
  maxOutputTokens: 8192,
});

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identitySchema = z.strictObject({
  sourceId: id, versionId: id, originalSha256: sha256,
  originalByteLength: positiveInteger, pdfPageCount: positiveInteger,
  derivativeRecipeSha256: sha256,
});
export type SourceIdentity = z.infer<typeof identitySchema>;
const reviewSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("synthetic_fixture"), fixtureId: id }),
  z.strictObject({ kind: z.literal("agent_reviewed_experimental"), reviewerAgent: id,
    reviewReportSha256: sha256, checkedSpanIds: z.array(id) }),
]);
export type ReviewProvenance =
  | { kind: "synthetic_fixture"; fixtureId: string }
  | { kind: "agent_reviewed_experimental"; reviewerAgent: string;
      reviewReportSha256: string; checkedSpanIds: readonly string[] };
const bundleSchema = z.strictObject({
  schemaVersion: z.literal(1), purpose: z.literal("offline_evaluation"),
  sourceKind: z.enum(["synthetic_fixture", "authorized_local_original"]),
  identity: identitySchema, review: reviewSchema,
  pages: z.array(z.strictObject({ id, pdfOrdinal: positiveInteger,
    text: z.string().min(1), textSha256: sha256 })),
  spans: z.array(z.strictObject({ id, pageId: id,
    startByte: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    endByte: positiveInteger, passageSha256: sha256,
    requiredContextSpanIds: z.array(id) })),
});
export type SourceEvaluationBundle = Omit<z.infer<typeof bundleSchema>, "review"> & { review: ReviewProvenance };
const requestSchema = z.strictObject({ sourceId: id, versionId: id,
  pdfOrdinal: positiveInteger.optional(), reviewedSpanId: id.optional(),
  exactAnchor: z.string().min(1).optional() });
export type EvaluationEvidenceRequest = z.infer<typeof requestSchema>;
export type EvaluationRegistry = ReadonlyMap<string, { expectedIdentity: SourceIdentity; bundle: unknown }>;

export type EvaluationPassage = Readonly<SourceIdentity & {
  evidenceId: string; pageId: string; pdfOrdinal: number; pageTextSha256: string;
  spanId: string; startByte: number; endByte: number; passageSha256: string; text: string;
  sourceKind: SourceEvaluationBundle["sourceKind"]; review: Readonly<ReviewProvenance>;
  requiredContextEvidenceIds: readonly string[];
}>;
export type EvaluationEvidence = Readonly<{
  purpose: "offline_evaluation"; productionEligible: false; passages: readonly EvaluationPassage[];
}>;
export type EvidenceUnavailableReason =
  | "no_requests" | "invalid_request" | "source_not_registered" | "identity_mismatch"
  | "invalid_bundle" | "invalid_utf8" | "integrity_mismatch" | "invalid_span"
  | "missing_context" | "unreviewed_span" | "missing_locator" | "locator_not_found"
  | "ambiguous_locator" | "limit_exceeded";
export type EvidenceResolution =
  | Readonly<{ status: "resolved"; evidence: EvaluationEvidence }>
  | Readonly<{ status: "unavailable"; reason: EvidenceUnavailableReason }>;

type Page = SourceEvaluationBundle["pages"][number];
type Span = SourceEvaluationBundle["spans"][number];
type ValidBundle = { bundle: SourceEvaluationBundle; pages: Map<string, Page>;
  spans: Map<string, Span>; texts: Map<string, string> };
const unavailable = (reason: EvidenceUnavailableReason): EvidenceResolution => Object.freeze({ status: "unavailable", reason });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// Buffer.from otherwise silently replaces lone surrogates with U+FFFD.
function validUnicode(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function validateBundle(input: unknown): ValidBundle | EvidenceUnavailableReason {
  const parsed = bundleSchema.safeParse(input);
  if (!parsed.success) return "invalid_bundle";
  const bundle = parsed.data;
  if ((bundle.sourceKind === "synthetic_fixture") !== (bundle.review.kind === "synthetic_fixture")) return "invalid_bundle";
  // Registry derivatives are bounded independently as well as in the final selection.
  if (bundle.pages.length > EVALUATION_LIMITS.maxPages) return "limit_exceeded";
  const pages = new Map<string, Page>();
  const ordinals = new Set<number>();
  const bytesByPage = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const page of bundle.pages) {
    if (pages.has(page.id) || ordinals.has(page.pdfOrdinal) || page.pdfOrdinal > bundle.identity.pdfPageCount) return "invalid_bundle";
    if (!validUnicode(page.text)) return "invalid_utf8";
    const bytes = Buffer.from(page.text, "utf8");
    totalBytes += bytes.length;
    if (totalBytes > EVALUATION_LIMITS.maxEvidenceTextBytes) return "limit_exceeded";
    if (hash(bytes) !== page.textSha256) return "integrity_mismatch";
    pages.set(page.id, page); ordinals.add(page.pdfOrdinal); bytesByPage.set(page.id, bytes);
  }
  const spans = new Map<string, Span>();
  const texts = new Map<string, string>();
  for (const span of bundle.spans) {
    if (spans.has(span.id) || new Set(span.requiredContextSpanIds).size !== span.requiredContextSpanIds.length) return "invalid_bundle";
    const bytes = bytesByPage.get(span.pageId);
    if (!bytes || span.startByte >= span.endByte || span.endByte > bytes.length) return "invalid_span";
    // A fatal decoder rejects offsets inside a multibyte sequence; ignoreBOM preserves exact text.
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(span.startByte, span.endByte)); }
    catch { return "invalid_span"; }
    if (hash(Buffer.from(text, "utf8")) !== span.passageSha256) return "integrity_mismatch";
    spans.set(span.id, span); texts.set(span.id, text);
  }
  for (const span of spans.values()) {
    if (span.requiredContextSpanIds.some((contextId) => !spans.has(contextId))) return "missing_context";
  }
  if (bundle.review.kind === "agent_reviewed_experimental") {
    const checked = bundle.review.checkedSpanIds;
    if (new Set(checked).size !== checked.length || checked.some((spanId) => !spans.has(spanId))) return "invalid_bundle";
  }
  return { bundle, pages, spans, texts };
}
function wholeDocumentCovered(valid: ValidBundle): boolean {
  const { bundle } = valid;
  if (bundle.pages.length !== bundle.identity.pdfPageCount || bundle.pages.length === 0) return false;
  return bundle.pages.every((page) => {
    const intervals = bundle.spans.filter((span) => span.pageId === page.id)
      .sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);
    let coveredUntil = 0;
    for (const span of intervals) {
      if (span.startByte > coveredUntil) return false;
      coveredUntil = Math.max(coveredUntil, span.endByte);
    }
    return coveredUntil === Buffer.byteLength(page.text, "utf8");
  });
}
function selectSpans(valid: ValidBundle, request: EvaluationEvidenceRequest): Span[] | EvidenceUnavailableReason {
  const { bundle, spans } = valid;
  let candidates = bundle.spans;
  let located = false;
  if (request.reviewedSpanId !== undefined) {
    const span = spans.get(request.reviewedSpanId);
    if (!span) return "locator_not_found";
    candidates = [span]; located = true;
  }
  if (request.pdfOrdinal !== undefined) {
    const page = bundle.pages.find((p) => p.pdfOrdinal === request.pdfOrdinal);
    if (!page) return "locator_not_found";
    candidates = candidates.filter((span) => span.pageId === page.id); located = true;
  }
  if (request.exactAnchor !== undefined) {
    const anchor = request.exactAnchor;
    const hits: { pageId: string; startByte: number; endByte: number }[] = [];
    // Search the entire registered derivative, not only a hinted page. Count overlapping hits.
    for (const page of bundle.pages) {
      let from = 0;
      while (from <= page.text.length) {
        const at = page.text.indexOf(anchor, from);
        if (at < 0) break;
        const startByte = Buffer.byteLength(page.text.slice(0, at), "utf8");
        hits.push({ pageId: page.id, startByte, endByte: startByte + Buffer.byteLength(anchor, "utf8") });
        if (hits.length > 1) return "ambiguous_locator";
        from = at + 1;
      }
    }
    if (!hits.length) return "locator_not_found";
    const hit = hits[0];
    candidates = candidates.filter((span) => span.pageId === hit.pageId && span.startByte <= hit.startByte && span.endByte >= hit.endByte);
    located = true;
  }
  if (!located && !wholeDocumentCovered(valid)) return "missing_locator";
  if (!candidates.length) return located ? "locator_not_found" : "missing_locator";
  return candidates;
}
function frozenReview(review: ReviewProvenance): Readonly<ReviewProvenance> {
  return review.kind === "synthetic_fixture" ? Object.freeze({ ...review })
    : Object.freeze({ ...review, checkedSpanIds: Object.freeze([...review.checkedSpanIds]) });
}

/** Pure experimental resolver. Local controller registration is its only authority. */
export function resolveEvaluationEvidence(
  registry: EvaluationRegistry,
  requests: readonly EvaluationEvidenceRequest[],
): EvidenceResolution {
  const parsed = z.array(requestSchema).safeParse(requests);
  if (!parsed.success) return unavailable("invalid_request");
  if (!parsed.data.length) return unavailable("no_requests");
  if (parsed.data.some((r) => r.exactAnchor !== undefined && !validUnicode(r.exactAnchor))) return unavailable("invalid_request");
  if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > EVALUATION_LIMITS.maxSerializedInputBytes) return unavailable("limit_exceeded");
  const sources = new Set(parsed.data.map((r) => r.sourceId));
  if (sources.size > EVALUATION_LIMITS.maxSourceVersions) return unavailable("limit_exceeded");
  const validated = new Map<string, ValidBundle>();
  const selected = new Map<string, Set<string>>();
  const pageKeys = new Set<string>();
  let evidenceBytes = 0;
  for (const request of parsed.data) {
    const entry = registry.get(request.sourceId);
    if (!entry) return unavailable("source_not_registered");
    let valid = validated.get(request.sourceId);
    if (!valid) {
      const result = validateBundle(entry.bundle);
      if (typeof result === "string") return unavailable(result);
      const expected = identitySchema.safeParse(entry.expectedIdentity);
      if (!expected.success || Object.keys(expected.data).some((key) =>
        expected.data[key as keyof SourceIdentity] !== result.bundle.identity[key as keyof SourceIdentity])) return unavailable("identity_mismatch");
      valid = result; validated.set(request.sourceId, valid);
    }
    if (valid.bundle.identity.sourceId !== request.sourceId || valid.bundle.identity.versionId !== request.versionId) return unavailable("identity_mismatch");
    const candidates = selectSpans(valid, request);
    if (typeof candidates === "string") return unavailable(candidates);
    const chosen = selected.get(request.sourceId) ?? new Set<string>();
    selected.set(request.sourceId, chosen);
    const pending: string[] = [];
    const review = valid.bundle.review;
    const checked = review.kind === "agent_reviewed_experimental" ? new Set(review.checkedSpanIds) : null;
    const enqueue = (spanId: string): EvidenceUnavailableReason | undefined => {
      if (chosen.has(spanId)) return;
      if (checked && !checked.has(spanId)) return "unreviewed_span";
      const span = valid.spans.get(spanId);
      if (!span) return "missing_context";
      const pageKey = JSON.stringify([request.sourceId, request.versionId, span.pageId]);
      const nextPageCount = pageKeys.size + (pageKeys.has(pageKey) ? 0 : 1);
      const nextEvidenceBytes = evidenceBytes + span.endByte - span.startByte;
      if (nextPageCount > EVALUATION_LIMITS.maxPages || nextEvidenceBytes > EVALUATION_LIMITS.maxEvidenceTextBytes) return "limit_exceeded";
      // Count and deduplicate at enqueue time, before allocating pending/output records.
      pageKeys.add(pageKey); evidenceBytes = nextEvidenceBytes;
      chosen.add(spanId); pending.push(spanId);
    };
    for (const candidate of candidates) {
      const reason = enqueue(candidate.id);
      if (reason) return unavailable(reason);
    }
    while (pending.length) {
      const spanId = pending.pop()!;
      const span = valid.spans.get(spanId)!;
      for (const contextId of span.requiredContextSpanIds) {
        const reason = enqueue(contextId);
        if (reason) return unavailable(reason);
      }
    }
  }
  const records: { valid: ValidBundle; span: Span; key: string }[] = [];
  for (const [sourceId, spanIds] of selected) {
    const valid = validated.get(sourceId)!;
    for (const spanId of spanIds) {
      const span = valid.spans.get(spanId)!;
      records.push({ valid, span, key: JSON.stringify([sourceId, spanId]) });
    }
  }
  records.sort((a, b) => {
    const sourceA = a.valid.bundle.identity.sourceId, sourceB = b.valid.bundle.identity.sourceId;
    return (sourceA < sourceB ? -1 : sourceA > sourceB ? 1 : 0)
      || a.valid.pages.get(a.span.pageId)!.pdfOrdinal - b.valid.pages.get(b.span.pageId)!.pdfOrdinal
      || a.span.startByte - b.span.startByte || (a.span.id < b.span.id ? -1 : a.span.id > b.span.id ? 1 : 0);
  });
  const evidenceIds = new Map(records.map((record, i) => [record.key, `evidence-${i + 1}`]));
  const reviews = new Map([...validated].map(([sourceId, valid]) => [sourceId, frozenReview(valid.bundle.review)]));
  const passages = records.map(({ valid, span, key }) => Object.freeze({
    ...valid.bundle.identity, evidenceId: evidenceIds.get(key)!, sourceKind: valid.bundle.sourceKind,
    pageId: span.pageId, pdfOrdinal: valid.pages.get(span.pageId)!.pdfOrdinal,
    pageTextSha256: valid.pages.get(span.pageId)!.textSha256,
    spanId: span.id, startByte: span.startByte, endByte: span.endByte,
    passageSha256: span.passageSha256, text: valid.texts.get(span.id)!, review: reviews.get(valid.bundle.identity.sourceId)!,
    requiredContextEvidenceIds: Object.freeze(span.requiredContextSpanIds.map((contextId) =>
      evidenceIds.get(JSON.stringify([valid.bundle.identity.sourceId, contextId]))!)),
  }));
  return Object.freeze({ status: "resolved", evidence: Object.freeze({
    purpose: "offline_evaluation", productionEligible: false, passages: Object.freeze(passages),
  }) });
}
