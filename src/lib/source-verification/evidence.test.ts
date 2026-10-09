import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EVALUATION_LIMITS,
  resolveEvaluationEvidence,
  type EvaluationEvidenceRequest,
  type SourceEvaluationBundle,
} from "./evidence";

// Authored synthetic data only; no copied user, source, or provider material.
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function fixture(texts = ["A café 😀 e\u0301 rule."]): SourceEvaluationBundle {
  return {
    schemaVersion: 1,
    purpose: "offline_evaluation",
    sourceKind: "synthetic_fixture",
    identity: {
      sourceId: "source-1", versionId: "version-1", originalSha256: hash("synthetic original"),
      originalByteLength: 18, pdfPageCount: texts.length, derivativeRecipeSha256: hash("recipe"),
    },
    review: { kind: "synthetic_fixture", fixtureId: "fixture-1" },
    pages: texts.map((text, i) => ({ id: `page-${i + 1}`, pdfOrdinal: i + 1, text, textSha256: hash(text) })),
    spans: texts.map((text, i) => ({ id: `span-${i + 1}`, pageId: `page-${i + 1}`, startByte: 0,
      endByte: Buffer.byteLength(text), passageSha256: hash(text), requiredContextSpanIds: [] })),
  };
}
function resolve(bundle: SourceEvaluationBundle, request: Record<string, unknown> = {}) {
  return resolveEvaluationEvidence(new Map([[bundle.identity.sourceId, {
    expectedIdentity: { ...bundle.identity }, bundle,
  }]]), [{ sourceId: bundle.identity.sourceId, versionId: bundle.identity.versionId, ...request }] as EvaluationEvidenceRequest[]);
}
function unavailable(bundle: SourceEvaluationBundle, reason: string, request: Record<string, unknown> = {}) {
  expect(resolve(bundle, request)).toEqual({ status: "unavailable", reason });
}
function agentFixture() {
  const bundle = fixture(["A governing condition.", "A dependent rule."]);
  bundle.sourceKind = "authorized_local_original";
  bundle.review = { kind: "agent_reviewed_experimental", reviewerAgent: "agent-1",
    reviewReportSha256: hash("synthetic review"), checkedSpanIds: ["span-1", "span-2"] };
  bundle.spans[1].requiredContextSpanIds = ["span-1"];
  return bundle;
}

describe("experimental evidence resolution", () => {
  it("exports exactly the approved resource limits", () => {
    expect(EVALUATION_LIMITS).toEqual({ maxSourceVersions: 8, maxPages: 24, maxEvidenceTextBytes: 65536,
      maxQuestionFactsDraftBytes: 32768, maxSegments: 64, maxClaims: 64,
      maxEvidenceReferencesPerClaim: 8, maxSerializedInputBytes: 131072,
      maxResponseJsonBytes: 65536, maxOutputTokens: 8192 });
    expect(Object.isFrozen(EVALUATION_LIMITS)).toBe(true);
  });
  it("preserves exact UTF-8 including decomposed text and immutable provenance", () => {
    const bundle = fixture();
    const result = resolve(bundle, { reviewedSpanId: "span-1" });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("resolution required");
    expect(result.evidence.purpose).toBe("offline_evaluation");
    expect(result.evidence.productionEligible).toBe(false);
    expect(result.evidence.passages[0]).toMatchObject({ evidenceId: "evidence-1", sourceId: "source-1",
      versionId: "version-1", originalSha256: bundle.identity.originalSha256,
      derivativeRecipeSha256: bundle.identity.derivativeRecipeSha256, pdfOrdinal: 1,
      pageId: "page-1", spanId: "span-1", text: bundle.pages[0].text,
      startByte: 0, endByte: Buffer.byteLength(bundle.pages[0].text), review: bundle.review });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evidence.passages)).toBe(true);
    expect(Object.isFrozen(result.evidence.passages[0].review)).toBe(true);
    bundle.pages[0].text = "mutated";
    bundle.identity.versionId = "mutated";
    bundle.spans[0].requiredContextSpanIds.push("mutated");
    expect(result.evidence.passages[0].text).toBe("A café 😀 e\u0301 rule.");
    expect(result.evidence.passages[0].versionId).toBe("version-1");
    expect(result.evidence.passages[0].requiredContextEvidenceIds).toEqual([]);
  });
  it.each(["sourceId", "versionId", "originalSha256", "originalByteLength", "pdfPageCount", "derivativeRecipeSha256"] as const)("rejects registry identity mismatch: %s", (field) => {
    const bundle = fixture();
    const expectedIdentity = { ...bundle.identity };
    Object.assign(expectedIdentity, { [field]: typeof expectedIdentity[field] === "number" ? 99 : field.endsWith("Sha256") ? hash("wrong") : "other" });
    expect(resolveEvaluationEvidence(new Map([["source-1", { expectedIdentity, bundle }]]),
      [{ sourceId: "source-1", versionId: "version-1" }])).toEqual({ status: "unavailable", reason: "identity_mismatch" });
  });
  it("cannot authorize identical bytes through another registry identity", () => {
    const bundle = fixture();
    const registry = new Map([["other-source", { expectedIdentity: bundle.identity, bundle }]]);
    expect(resolveEvaluationEvidence(registry, [{ sourceId: "source-1", versionId: "version-1" }])).toEqual({ status: "unavailable", reason: "source_not_registered" });
    expect(resolveEvaluationEvidence(registry, [{ sourceId: "other-source", versionId: "version-1" }])).toEqual({ status: "unavailable", reason: "identity_mismatch" });
    unavailable(bundle, "identity_mismatch", { versionId: "other-version" });
  });
  it.each(["page", "passage"])("rejects wrong %s hashes", (kind) => {
    const bundle = fixture();
    if (kind === "page") bundle.pages[0].textSha256 = hash("wrong");
    else bundle.spans[0].passageSha256 = hash("wrong");
    unavailable(bundle, "integrity_mismatch");
  });
  it.each(["\ud800", "\udc00", "text\ud800tail"])("rejects lone UTF-16 surrogates without replacement", (text) => unavailable(fixture([text]), "invalid_utf8"));
  it("rejects byte buffers masquerading as text", () => {
    const bundle = fixture();
    Object.assign(bundle.pages[0], { text: Buffer.from([0xff]) });
    unavailable(bundle, "invalid_bundle");
  });
  it.each([[1, 2], [0, 1], [0, 3]])("rejects split UTF-8 boundaries %s..%s", (startByte, endByte) => {
    const bundle = fixture(["é😀"]);
    Object.assign(bundle.spans[0], { startByte, endByte, passageSha256: hash("invalid") });
    unavailable(bundle, "invalid_span");
  });
  it.each([[0, 0], [-1, 2], [0, 999], [2, 1]])("rejects invalid span range %s..%s", (startByte, endByte) => {
    const bundle = fixture(); Object.assign(bundle.spans[0], { startByte, endByte });
    unavailable(bundle, startByte < 0 || endByte === 0 ? "invalid_bundle" : "invalid_span");
  });
  it.each(["page", "span", "ordinal"])("rejects duplicate %s identities", (kind) => {
    const bundle = fixture(["one", "two"]);
    if (kind === "page") bundle.pages[1].id = bundle.pages[0].id;
    else if (kind === "span") bundle.spans[1].id = bundle.spans[0].id;
    else bundle.pages[1].pdfOrdinal = 1;
    unavailable(bundle, "invalid_bundle");
  });
  it("rejects a span on an unknown page", () => {
    const bundle = fixture(); bundle.spans[0].pageId = "missing";
    unavailable(bundle, "invalid_span");
  });
  it("includes reviewed governing context and terminates cyclic traversal", () => {
    const bundle = agentFixture(); bundle.spans[0].requiredContextSpanIds = ["span-2"];
    const result = resolve(bundle, { reviewedSpanId: "span-2" });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("resolution required");
    expect(result.evidence.passages.map((p) => p.spanId)).toEqual(["span-1", "span-2"]);
    expect(result.evidence.passages[1].requiredContextEvidenceIds).toEqual(["evidence-1"]);
    expect(Object.isFrozen(result.evidence.passages[0].review)).toBe(true);
    expect(Object.isFrozen(result.evidence.passages[0].requiredContextEvidenceIds)).toBe(true);
  });
  it("rejects duplicated context IDs", () => {
    const bundle = agentFixture(); bundle.spans[1].requiredContextSpanIds.push("span-1");
    unavailable(bundle, "invalid_bundle", { reviewedSpanId: "span-2" });
  });
  it("withholds unresolved context", () => {
    const bundle = agentFixture(); bundle.spans[1].requiredContextSpanIds = ["missing"];
    unavailable(bundle, "missing_context", { reviewedSpanId: "span-2" });
  });
  it("withholds unreviewed selected or governing spans", () => {
    for (const checkedSpanIds of [["span-1"], ["span-2"]]) {
      const bundle = agentFixture(); Object.assign(bundle.review, { checkedSpanIds });
      unavailable(bundle, "unreviewed_span", { reviewedSpanId: "span-2" });
    }
  });
  it("allows irrelevant unreviewed spans without broadening review approval", () => {
    const bundle = agentFixture(); Object.assign(bundle.review, { checkedSpanIds: ["span-1"] });
    expect(resolve(bundle, { reviewedSpanId: "span-1" }).status).toBe("resolved");
  });
  it("rejects unknown or duplicated checked span IDs", () => {
    for (const checkedSpanIds of [["missing"], ["span-1", "span-1"]]) {
      const bundle = agentFixture(); Object.assign(bundle.review, { checkedSpanIds }); unavailable(bundle, "invalid_bundle");
    }
  });
  it.each(["human_approved", "human_reviewed"])("rejects forged %s review", (kind) => {
    const bundle = fixture(); Object.assign(bundle.review, { kind }); unavailable(bundle, "invalid_bundle");
  });
  it.each(["path", "url", "productionEligible", "promotion", "storageId"])("rejects unknown bundle property %s", (field) => {
    const bundle = fixture(); Object.assign(bundle, { [field]: "forged" }); unavailable(bundle, "invalid_bundle");
  });
  it("rejects unknown nested fields and inconsistent source/review kinds", () => {
    const bundles = [fixture(), fixture(), fixture(), fixture(), fixture()];
    Object.assign(bundles[0].identity, { url: "https://invalid.example" });
    Object.assign(bundles[1].pages[0], { path: "fake" });
    Object.assign(bundles[2].spans[0], { subsection: "c" });
    Object.assign(bundles[3].review, { humanApproved: true });
    bundles[4].sourceKind = "authorized_local_original";
    for (const bundle of bundles) unavailable(bundle, "invalid_bundle");
  });
  it("selects validated page spans with required context", () => {
    const result = resolve(agentFixture(), { pdfOrdinal: 2 });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("resolution required");
    expect(result.evidence.passages.map((p) => p.pdfOrdinal)).toEqual([1, 2]);
  });
  it("uses a unique exact anchor without normalizing text or claiming entailment", () => {
    expect(resolve(fixture(), { exactAnchor: "e\u0301 rule" }).status).toBe("resolved");
    unavailable(fixture(), "locator_not_found", { exactAnchor: "é rule" });
  });
  it("counts overlapping anchor occurrences as ambiguous", () => unavailable(fixture(["aaa"]), "ambiguous_locator", { exactAnchor: "aa" }));
  it("rejects anchors ambiguous across pages even with a page hint", () => unavailable(fixture(["same", "same"]), "ambiguous_locator", { exactAnchor: "same", pdfOrdinal: 1 }));
  it("requires all supplied locators to agree", () => {
    unavailable(fixture(["one", "two"]), "locator_not_found", { reviewedSpanId: "span-1", pdfOrdinal: 2 });
    unavailable(fixture(["one", "two"]), "locator_not_found", { reviewedSpanId: "span-1", exactAnchor: "two" });
  });
  it("does not guess missing pages, spans, or subsection letters", () => {
    unavailable(fixture(), "locator_not_found", { pdfOrdinal: 2 });
    unavailable(fixture(), "locator_not_found", { reviewedSpanId: "subsection-c" });
  });
  it("only falls back to a complete short document with full span coverage", () => {
    expect(resolve(fixture(["one", "two"])).status).toBe("resolved");
    const bundle = fixture(["prefix rule suffix"]);
    Object.assign(bundle.spans[0], { startByte: 7, endByte: 11, passageSha256: hash("rule") });
    unavailable(bundle, "missing_locator");
    expect(resolve(bundle, { reviewedSpanId: "span-1" }).status).toBe("resolved");
    unavailable(bundle, "locator_not_found", { exactAnchor: "prefix" });
  });
  it("withholds a document missing pages during whole-document fallback", () => {
    const bundle = fixture(); bundle.identity.pdfPageCount = 2; unavailable(bundle, "missing_locator");
  });
  it.each(["startByte", "endByte", "citationStart", "url", "subsection"])("rejects caller offsets/unknown request field %s", (field) => unavailable(fixture(), "invalid_request", { [field]: 0 }));
  it.each([{ pdfOrdinal: 0 }, { exactAnchor: "" }, { exactAnchor: "\ud800" }, { sourceId: "https://invalid.example" }])("rejects invalid request %j", (request) => unavailable(fixture(), "invalid_request", request));
  it("returns evidence-unavailable independently of corpus absence or answer policy", () => {
    expect(resolveEvaluationEvidence(new Map(), [])).toEqual({ status: "unavailable", reason: "no_requests" });
    const bundle = fixture(); bundle.spans = [];
    unavailable(bundle, "missing_locator");
    unavailable(bundle, "locator_not_found", { pdfOrdinal: 1 });
  });
  it("deduplicates repeated requests and assigns stable evidence IDs", () => {
    const bundle = fixture();
    const result = resolveEvaluationEvidence(new Map([["source-1", { expectedIdentity: bundle.identity, bundle }]]),
      Array.from({ length: 30 }, () => ({ sourceId: "source-1", versionId: "version-1", pdfOrdinal: 1 })));
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("resolution required");
    expect(result.evidence.passages).toHaveLength(1);
  });
  it("enforces source-version count at exactly eight, with no prefix success", () => {
    const registry = new Map(); const requests: EvaluationEvidenceRequest[] = [];
    for (let i = 1; i <= 9; i++) {
      const bundle = fixture(["x"]); bundle.identity.sourceId = `source-${i}`;
      registry.set(bundle.identity.sourceId, { expectedIdentity: bundle.identity, bundle });
      requests.push({ sourceId: bundle.identity.sourceId, versionId: "version-1" });
    }
    expect(resolveEvaluationEvidence(registry, requests.slice(0, 8)).status).toBe("resolved");
    expect(resolveEvaluationEvidence(registry, requests)).toEqual({ status: "unavailable", reason: "limit_exceeded" });
  });
  it("enforces deduplicated page count at exactly 24", () => {
    expect(resolve(fixture(Array(24).fill("x"))).status).toBe("resolved");
    unavailable(fixture(Array(25).fill("x")), "limit_exceeded");
    const a = fixture(Array(12).fill("x")); const b = fixture(Array(13).fill("x")); b.identity.sourceId = "source-2";
    const registry = new Map([["source-1", { expectedIdentity: a.identity, bundle: a }], ["source-2", { expectedIdentity: b.identity, bundle: b }]]);
    expect(resolveEvaluationEvidence(registry, [a, b].map((v) => ({ sourceId: v.identity.sourceId, versionId: "version-1" })))).toEqual({ status: "unavailable", reason: "limit_exceeded" });
  });
  it("enforces UTF-8 evidence bytes at exactly 64 KiB", () => {
    expect(resolve(fixture(["é".repeat(32768)])).status).toBe("resolved");
    unavailable(fixture(["é".repeat(32768) + "x"]), "limit_exceeded");
    const a = fixture(["x".repeat(32768)]); const b = fixture(["y".repeat(32769)]); b.identity.sourceId = "source-2";
    const registry = new Map([["source-1", { expectedIdentity: a.identity, bundle: a }], ["source-2", { expectedIdentity: b.identity, bundle: b }]]);
    expect(resolveEvaluationEvidence(registry, [a, b].map((v) => ({ sourceId: v.identity.sourceId, versionId: "version-1" })))).toEqual({ status: "unavailable", reason: "limit_exceeded" });
  });
  it("bounds serialized locator requests at exactly 128 KiB without truncation", () => {
    const base = [{ sourceId: "source-1", versionId: "version-1", exactAnchor: "" }];
    const overhead = Buffer.byteLength(JSON.stringify(base));
    const exactAnchor = "x".repeat(131072 - overhead);
    unavailable(fixture(), "locator_not_found", { exactAnchor });
    unavailable(fixture(), "limit_exceeded", { exactAnchor: exactAnchor + "x" });
  });
  it("preserves BOMs, CRLFs, URL prose, and a correctly bounded multibyte subspan", () => {
    const text = "\ufeffprefix\r\ncafé 😀 https://invalid.example\r\nsuffix";
    const bundle = fixture([text]);
    const passage = "café 😀 https://invalid.example";
    const startByte = Buffer.byteLength("\ufeffprefix\r\n");
    Object.assign(bundle.spans[0], { startByte, endByte: startByte + Buffer.byteLength(passage), passageSha256: hash(passage) });
    const result = resolve(bundle, { exactAnchor: "😀" });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("resolution required");
    expect(result.evidence.passages[0].text).toBe(passage);
    expect(result.evidence.passages[0].startByte).toBe(startByte);
    const whole = resolve(fixture([text]));
    expect(whole.status).toBe("resolved");
    if (whole.status !== "resolved") throw new Error("resolution required");
    expect(whole.evidence.passages[0].text).toBe(text);
  });
  it("freezes every result layer and the copied agent review IDs", () => {
    const bundle = agentFixture();
    const result = resolve(bundle, { reviewedSpanId: "span-2" });
    if (result.status !== "resolved") throw new Error("resolution required");
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidence.passages[0])).toBe(true);
    const review = result.evidence.passages[0].review;
    if (review.kind !== "agent_reviewed_experimental") throw new Error("agent provenance required");
    expect(Object.isFrozen(review.checkedSpanIds)).toBe(true);
    Object.assign(bundle.review, { checkedSpanIds: [] });
    expect(review.checkedSpanIds).toEqual(["span-1", "span-2"]);
    expect(() => Reflect.set(result.evidence, "productionEligible", true)).not.toThrow();
    expect(result.evidence.productionEligible).toBe(false);
  });
  it("orders evidence deterministically independent of request and bundle span order", () => {
    const bundle = fixture(["one", "two"]);
    const first = resolve(bundle);
    bundle.spans.reverse(); bundle.pages.reverse();
    const second = resolveEvaluationEvidence(new Map([["source-1", { expectedIdentity: bundle.identity, bundle }]]),
      [2, 1].map((pdfOrdinal) => ({ sourceId: "source-1", versionId: "version-1", pdfOrdinal })));
    expect(second).toEqual(first);
  });
  it("withholds when selected governing context exceeds the combined page bound", () => {
    const a = fixture(Array(24).fill("x"));
    a.spans[0].requiredContextSpanIds = a.spans.slice(1).map((span) => span.id);
    const b = fixture(["y"]); b.identity.sourceId = "source-2";
    const registry = new Map([["source-1", { expectedIdentity: a.identity, bundle: a }], ["source-2", { expectedIdentity: b.identity, bundle: b }]]);
    expect(resolveEvaluationEvidence(registry, [a, b].map((v) => ({ sourceId: v.identity.sourceId, versionId: "version-1", reviewedSpanId: "span-1" })))).toEqual({ status: "unavailable", reason: "limit_exceeded" });
  });
  it("does not deduplicate pages or authority by matching content hashes", () => {
    const bundle = fixture(Array(24).fill("same"));
    const result = resolve(bundle);
    if (result.status !== "resolved") throw new Error("resolution required");
    expect(result.evidence.passages).toHaveLength(24);
  });
  it("withholds a valid 150000-span context fan-out without throwing or dropping dependencies", () => {
    const bundle = fixture(["x"]);
    const passageSha256 = hash("x");
    bundle.spans = Array.from({ length: 150000 }, (_, i) => ({ id: `span-${i + 1}`, pageId: "page-1",
      startByte: 0, endByte: 1, passageSha256, requiredContextSpanIds: [] }));
    bundle.spans[0].requiredContextSpanIds = bundle.spans.slice(1).map((span) => span.id);
    unavailable(bundle, "limit_exceeded", { reviewedSpanId: "span-1" });
  });
  it("shares one frozen independent agent review snapshot across many selected spans", () => {
    const text = "x".repeat(128);
    const bundle = fixture([text]);
    bundle.sourceKind = "authorized_local_original";
    const passageSha256 = hash(text);
    bundle.spans = Array.from({ length: 8192 }, (_, i) => ({ id: `span-${i + 1}`, pageId: "page-1",
      startByte: 0, endByte: 128, passageSha256, requiredContextSpanIds: [] }));
    bundle.spans[0].requiredContextSpanIds = bundle.spans.slice(1, 512).map((span) => span.id);
    const inputCheckedIds = bundle.spans.map((span) => span.id);
    bundle.review = { kind: "agent_reviewed_experimental", reviewerAgent: "agent-1",
      reviewReportSha256: hash("synthetic many-span review"), checkedSpanIds: inputCheckedIds };
    const result = resolve(bundle, { reviewedSpanId: "span-1" });
    if (result.status !== "resolved") throw new Error("resolution required");
    expect(result.evidence.passages).toHaveLength(512);
    expect(result.evidence.passages.reduce((bytes, span) => bytes + Buffer.byteLength(span.text), 0)).toBe(65536);
    bundle.spans[0].requiredContextSpanIds.push("span-513");
    unavailable(bundle, "limit_exceeded", { reviewedSpanId: "span-1" });
    const sharedReview = result.evidence.passages[0].review;
    expect(result.evidence.passages.every((passage) => passage.review === sharedReview)).toBe(true);
    expect(sharedReview).not.toBe(bundle.review);
    expect(Object.isFrozen(sharedReview)).toBe(true);
    if (sharedReview.kind !== "agent_reviewed_experimental") throw new Error("agent provenance required");
    expect(sharedReview.checkedSpanIds).not.toBe(inputCheckedIds);
    expect(Object.isFrozen(sharedReview.checkedSpanIds)).toBe(true);
    inputCheckedIds[0] = "mutated";
    inputCheckedIds.pop();
    Object.assign(bundle.review, { reviewerAgent: "mutated" });
    expect(sharedReview.checkedSpanIds[0]).toBe("span-1");
    expect(sharedReview.checkedSpanIds).toHaveLength(8192);
    expect(sharedReview.reviewerAgent).toBe("agent-1");
  });
});
