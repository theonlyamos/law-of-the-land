// @vitest-environment node
import { createHash } from "node:crypto";
import type { Interactions } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatVerificationGate, type ChatVerificationDependencies } from "./chat-verification-gate";
import { createGeminiEvaluationVerifier, type GeminiEvaluationClient } from "./gemini-verifier";
import type { EvaluationEvidenceRequest, SourceEvaluationBundle } from "./evidence";

// Authored test data only. The declared review simulates the injected server registry;
// it is not a review claim about any real legal document or user attachment.
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function fixture(): SourceEvaluationBundle {
  const texts = ["This fee applies only to licensed operators.", "The fee is five units."];
  return { schemaVersion: 1, purpose: "offline_evaluation", sourceKind: "authorized_local_original",
    identity: { sourceId: "source-1", versionId: "version-1", originalSha256: hash("original"),
      originalByteLength: 8, pdfPageCount: 2, derivativeRecipeSha256: hash("recipe") },
    review: { kind: "agent_reviewed_experimental", reviewerAgent: "fixture-reviewer",
      reviewReportSha256: hash("fixture-review"), checkedSpanIds: ["span-1", "span-2"] },
    pages: texts.map((text, i) => ({ id: `page-${i + 1}`, pdfOrdinal: i + 1, text, textSha256: hash(text) })),
    spans: texts.map((text, i) => ({ id: `span-${i + 1}`, pageId: `page-${i + 1}`, startByte: 0,
      endByte: Buffer.byteLength(text), passageSha256: hash(text), requiredContextSpanIds: i ? ["span-1"] : [] })) };
}
const input = () => { const now = Date.now(); return ({ kind: "legal" as const, question: "What fee applies, and when must I pay?",
  facts: "I am a licensed operator. A private attachment alleges a ten-unit fee.",
  candidate: "The fee is five units.\n\nThe passages do not establish when payment is due.",
  requests: [{ sourceId: "source-1", versionId: "version-1", reviewedSpanId: "span-2" }] as EvaluationEvidenceRequest[],
  requestStartedAt: now - 40_000, deadlineAt: now + 50_000 }); };
const verdict = (second = "evidence_gap", decision = "pass") => ({ decision, segments: [
  { segmentId: "segment-1", claims: [{ claimId: "claim-1", status: "supported", evidenceIds: ["evidence-1", "evidence-2"] }] },
  { segmentId: "segment-2", claims: [{ claimId: "claim-2", status: second, evidenceIds: [] }] },
] });
const response = (value: unknown): Interactions.Interaction => ({ id: "private-response", status: "completed",
  steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(value) }] }] });
function setup() {
  const bundle = fixture();
  const registry = new Map([[bundle.identity.sourceId, { expectedIdentity: { ...bundle.identity }, bundle }]]);
  const resolveAuthority = vi.fn(async () => ({ status: "authorized" as const, identities: [{ ...bundle.identity }] }));
  const create = vi.fn<GeminiEvaluationClient["interactions"]["create"]>().mockResolvedValue(response(verdict()));
  const verifier = createGeminiEvaluationVerifier({ interactions: { create } });
  const dependencies = { registry, resolveAuthority, verifier };
  return { bundle, registry, resolveAuthority, create, verifier, dependencies,
    gate: createChatVerificationGate(dependencies) };
}
beforeEach(() => { vi.stubGlobal("fetch", () => { throw new Error("Unexpected external request"); }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("local reviewed-passage chat gate", () => {
  it.each([undefined, "completed", "incomplete", "budget_exceeded", "unknown"])("accepts a pass response status only when absent or completed: %s", async responseStatus => {
    const f = setup();
    const pass = { purpose: "offline_evaluation", productionEligible: false, decision: "pass", reason: "verified", evaluated: true,
      attemptCount: 1, segmentCount: 2, claimCount: 2, timingMs: { preparation: 0, provider: 1, validation: 0, total: 1 },
      ...(responseStatus === undefined ? {} : { responseStatus }) };
    const gate = createChatVerificationGate({ ...f.dependencies, verifier: { evaluate: vi.fn().mockResolvedValue(pass) } });
    expect(await gate.verify(input())).toMatchObject(responseStatus === undefined || responseStatus === "completed"
      ? { status: "pass", reason: "verified" } : { status: "withhold", reason: "verification_rejected" });
    expect(f.create).not.toHaveBeenCalled();
  });
  it("passes a complete supported answer plus an honest gap, bound to exact candidate bytes", async () => {
    const { gate, create, resolveAuthority } = setup(); const args = input();
    const result = await gate.verify(args);
    expect(result).toEqual({ purpose: "local_chat_verification", productionEligible: false,
      status: "pass", reason: "verified", reviewKind: "agent_reviewed_experimental",
      candidateSha256: hash(args.candidate), passageCount: 2, segmentCount: 2, claimCount: 2 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(resolveAuthority).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1].maxRetries).toBe(0);
    expect(create.mock.calls[0][1].timeout).toBeLessThanOrEqual(50_000);
    const request = create.mock.calls[0][0];
    expect(request.tools).toEqual([]);
    expect(JSON.stringify(request.input)).toContain("private attachment");
    expect(JSON.stringify(result)).not.toMatch(/private|licensed|five units|payment/);
  });
  it("is disabled for legal answers without injected server dependencies", async () => {
    expect(await createChatVerificationGate().verify(input())).toMatchObject({ status: "withhold", reason: "gate_disabled" });
  });
  it("withholds when runtime configuration only partially supplies server dependencies", async () => {
    const { dependencies } = setup();
    for (const partial of [{}, { registry: dependencies.registry },
      { registry: dependencies.registry, resolveAuthority: dependencies.resolveAuthority },
      { ...dependencies, verifier: {} }]) {
      await expect(Promise.resolve().then(() => createChatVerificationGate(partial as unknown as ChatVerificationDependencies).verify(input())))
        .resolves.toMatchObject({ status: "withhold", reason: "gate_disabled" });
    }
  });
  it.each(["policy", "document"] as const)("separates trusted %s applicability from legal approval", async (kind) => {
    const { gate, create, resolveAuthority } = setup();
    expect(await gate.verify({ kind })).toEqual({ purpose: "local_chat_verification", productionEligible: false,
      status: "not_applicable", reason: kind });
    expect(create).not.toHaveBeenCalled(); expect(resolveAuthority).not.toHaveBeenCalled();
  });
  it("rejects a whole-answer pass that omits a later segment", async () => {
    const { gate, create } = setup(); const partial = verdict(); partial.segments.pop();
    create.mockResolvedValue(response(partial));
    expect(await gate.verify(input())).toMatchObject({ status: "withhold", reason: "verification_rejected" });
  });
  it("does not salvage a supported opening when a later claim lacks evidence", async () => {
    const { gate, create } = setup(); create.mockResolvedValue(response(verdict("insufficient_evidence", "withhold")));
    expect(await gate.verify(input())).toMatchObject({ status: "withhold", reason: "verification_rejected" });
  });
  it.each(["versionId", "originalSha256", "derivativeRecipeSha256"] as const)("withholds a stale authority %s before verification", async (field) => {
    const { gate, create, resolveAuthority, bundle } = setup();
    resolveAuthority.mockResolvedValue({ status: "authorized", identities: [{ ...bundle.identity,
      [field]: field === "versionId" ? "future-version" : hash("changed") }] });
    expect(await gate.verify(input())).toMatchObject({ status: "withhold", reason: "authority_unavailable" });
    expect(create).not.toHaveBeenCalled();
  });
  it("requires the exact authority set, not an unrelated or duplicated grant", async () => {
    const { gate, create, resolveAuthority, bundle } = setup();
    resolveAuthority.mockResolvedValue({ status: "authorized", identities: [bundle.identity, bundle.identity] });
    expect(await gate.verify(input())).toMatchObject({ status: "withhold", reason: "authority_unavailable" });
    expect(create).not.toHaveBeenCalled();
  });
  it("withholds revoked current authority after a valid verdict", async () => {
    const { gate, create, resolveAuthority, bundle } = setup();
    resolveAuthority.mockResolvedValueOnce({ status: "authorized", identities: [bundle.identity] })
      .mockResolvedValueOnce({ status: "authorized", identities: [] });
    expect(await gate.verify(input())).toMatchObject({ status: "withhold", reason: "authority_changed" });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it.each(["unregistered", "unreviewed-context", "corrupt-hash", "missing-locator", "ambiguous-anchor", "synthetic"])("withholds %s evidence before verification", async (kind) => {
    const { gate, create, registry, bundle } = setup(); const args = input();
    if (kind === "unregistered") registry.clear();
    if (kind === "unreviewed-context" && bundle.review.kind === "agent_reviewed_experimental") bundle.review.checkedSpanIds = ["span-2"];
    if (kind === "corrupt-hash") bundle.pages[1].textSha256 = hash("corrupt");
    if (kind === "missing-locator") { args.requests = [{ sourceId: "source-1", versionId: "version-1" }]; bundle.spans.pop(); }
    if (kind === "ambiguous-anchor") args.requests = [{ sourceId: "source-1", versionId: "version-1", exactAnchor: "fee" }];
    if (kind === "synthetic") { bundle.sourceKind = "synthetic_fixture"; bundle.review = { kind: "synthetic_fixture", fixtureId: "test" }; }
    expect(await gate.verify(args)).toMatchObject({ status: "withhold", reason: "evidence_unavailable" });
    expect(create).not.toHaveBeenCalled();
  });
  it("detects review revocation during verification without changing source identity", async () => {
    const { gate, create, bundle } = setup();
    create.mockImplementation(async () => {
      if (bundle.review.kind === "agent_reviewed_experimental") bundle.review.checkedSpanIds = ["span-2"];
      return response(verdict());
    });
    expect(await gate.verify(input())).toMatchObject({ status: "withhold", reason: "evidence_changed" });
  });
  it("detects changed review provenance even when selected passage bytes stay the same", async () => {
    const { gate, create, bundle } = setup();
    create.mockImplementation(async () => {
      if (bundle.review.kind === "agent_reviewed_experimental") bundle.review.reviewReportSha256 = hash("replacement review");
      return response(verdict());
    });
    expect(await gate.verify(input())).toMatchObject({ status: "withhold", reason: "evidence_changed" });
  });
  it("snapshots the candidate and keeps private facts out of legal passage authority", async () => {
    const { gate, create, resolveAuthority } = setup(); const args = input(); const original = args.candidate;
    const pending = gate.verify(args); args.candidate = "A substituted unsupported answer.";
    const result = await pending;
    expect(result).toMatchObject({ status: "pass", candidateSha256: hash(original) });
    const payload = JSON.parse(create.mock.calls[0][0].input as string);
    expect(payload.facts).toContain("private attachment");
    expect(JSON.stringify(payload.evidence)).not.toContain("private attachment");
    expect(JSON.stringify(resolveAuthority.mock.calls)).not.toContain("private attachment");
  });
  it("rejects a callback pass that did not cover the prepared segment count", async () => {
    const { dependencies } = setup();
    const gate = createChatVerificationGate({ ...dependencies, verifier: { evaluate: async () => ({
      purpose: "offline_evaluation", productionEligible: false, decision: "pass", reason: "verified", evaluated: true,
      attemptCount: 1, segmentCount: 1, claimCount: 1, timingMs: { preparation: 0, provider: 0, validation: 0, total: 0 },
    }) } });
    expect(await gate.verify(input())).toMatchObject({ status: "withhold", reason: "verification_rejected" });
  });
  it("returns only a closed reason for authority and verifier exceptions", async () => {
    const first = setup(); first.resolveAuthority.mockRejectedValue(new Error("PRIVATE authority text"));
    const second = setup(); const gate = createChatVerificationGate({ ...second.dependencies,
      verifier: { evaluate: async () => { throw new Error("PRIVATE provider text"); } } });
    for (const [result, reason] of [[await first.gate.verify(input()), "authority_unavailable"],
      [await gate.verify(input()), "verification_unavailable"]] as const) {
      expect(result).toMatchObject({ status: "withhold", reason }); expect(JSON.stringify(result)).not.toContain("PRIVATE");
    }
  });
  it("rejects a refreshed or invalid deadline before authority", async () => {
    const { gate, create, resolveAuthority } = setup(); const args = input();
    expect(await gate.verify({ ...args, deadlineAt: args.requestStartedAt + 90_001 })).toMatchObject({ reason: "invalid_deadline" });
    expect(await gate.verify({ ...args, deadlineAt: Date.now() - 1 })).toMatchObject({ reason: "deadline_exceeded" });
    expect(resolveAuthority).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
  it("releases an uncooperative authority waiter at the original deadline and prevents late continuation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000); const { gate, resolveAuthority, create, bundle } = setup();
    let settle!: (value: { status: "authorized"; identities: typeof bundle.identity[] }) => void;
    resolveAuthority.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    const args = { ...input(), requestStartedAt: 10_020, deadlineAt: 100_020 };
    const pending = gate.verify(args); await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ status: "withhold", reason: "deadline_exceeded" });
    settle({ status: "authorized", identities: [bundle.identity] }); await Promise.resolve(); await Promise.resolve();
    expect(create).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("releases an uncooperative verifier waiter without granting a fresh window", async () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000); const { dependencies, resolveAuthority } = setup();
    let seenDeadline = 0, seenSignal: AbortSignal | undefined;
    const gate = createChatVerificationGate({ ...dependencies, verifier: { evaluate: (args: { deadlineAt: number; signal?: AbortSignal }) => {
      seenDeadline = args.deadlineAt; seenSignal = args.signal; return new Promise(() => {});
    } } });
    const pending = gate.verify({ ...input(), requestStartedAt: 10_030, deadlineAt: 100_030 });
    await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toMatchObject({ status: "withhold", reason: "deadline_exceeded" });
    expect(seenDeadline).toBe(100_030); expect(seenSignal?.aborted).toBe(true);
    expect(resolveAuthority).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("covers client abort during authority, consumes late rejection, and removes its waiter", async () => {
    vi.useFakeTimers(); const { gate, resolveAuthority, create } = setup(); const controller = new AbortController();
    let reject!: (reason: unknown) => void;
    resolveAuthority.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = gate.verify({ ...input(), signal: controller.signal }); controller.abort("PRIVATE abort");
    expect(await pending).toMatchObject({ status: "withhold", reason: "aborted" });
    reject(new Error("PRIVATE late error")); await Promise.resolve(); await Promise.resolve();
    expect(create).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("checks time again after a synchronous callback consumes the remaining budget", async () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000); const { gate, resolveAuthority, create, bundle } = setup();
    resolveAuthority.mockImplementation(async () => { vi.setSystemTime(150_000); return { status: "authorized", identities: [bundle.identity] }; });
    expect(await gate.verify(input())).toMatchObject({ status: "withhold", reason: "deadline_exceeded" });
    expect(create).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
