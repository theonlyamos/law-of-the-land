// @vitest-environment node
import type { Interactions } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReviewedEmploymentChat, isLocalReviewedEmploymentRequest, projectReviewedEmploymentDiagnostics, type ReviewedEmploymentDependencies } from "./reviewed-employment-chat";
import { createGeminiEvaluationVerifier, type GeminiEvaluationClient } from "./gemini-verifier";
import { getPilotCase, PILOT_CATALOG, PILOT_IDENTITY, PILOT_REGISTRY } from "./reviewed-source-cases";
import { resolveEvaluationEvidence } from "./evidence";

const candidate = "PRIVATE fixture draft with exact Unicode: café.\n\nSecond paragraph.";
const localEnv = { NODE_ENV: "development", LOCAL_REVIEWED_EMPLOYMENT_ENABLED: "1", CONVEX_DEPLOYMENT: "dev:adventurous-hummingbird-244",
  NEXT_PUBLIC_CONVEX_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.cloud", NEXT_PUBLIC_CONVEX_SITE_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.site" };
function fixture() {
  const pilot = getPilotCase("pilot-notice")!;
  const evidence = resolveEvaluationEvidence(PILOT_REGISTRY, pilot.requests);
  if (evidence.status !== "resolved") throw new Error("fixture evidence unavailable");
  const events: string[] = [];
  const grant = { status: "authorized" as const, identities: [PILOT_IDENTITY], productionEligible: false as const,
    applicability: "source_edition_only" as const, requiresFinalAtomicCompletion: true as const,
    citationIdentity: { ...PILOT_CATALOG, providerStoreName: "fileSearchStores/fixture" },
    manifest: { authorizedScopeSize: 1, partialCoverage: false, stores: [{ jurisdictionId: PILOT_CATALOG.jurisdictionId,
      name: "Ghana", kind: "geographic" as const, relation: "selected" as const, storeName: "fileSearchStores/fixture" }] } };
  const resolve = vi.fn(async () => { events.push("authority"); return grant; });
  const draft = vi.fn<ReviewedEmploymentDependencies["draft"]["draft"]>(async () => { events.push("draft"); return { status: "drafted",
    candidate, productionEligible: false, attemptCount: 1, timingMs: { preparation: 0, provider: 0, validation: 0, total: 0 } }; });
  const create = vi.fn<GeminiEvaluationClient["interactions"]["create"]>().mockImplementation(async request => {
    events.push("verify"); const payload = JSON.parse(request.input as string);
    return { id: "fixture", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({ decision: "pass",
      segments: payload.segments.map((segment: { segmentId: string }, index: number) => ({ segmentId: segment.segmentId,
        claims: [{ claimId: `claim-${index}`, status: "supported", evidenceIds: payload.evidence.map((passage: { evidenceId: string }) => passage.evidenceId) }] })) }) }] }] } as Interactions.Interaction;
  });
  const commit = vi.fn<ReviewedEmploymentDependencies["commit"]>(async value => { events.push("commit"); return {
    status: "completed", outcome: "success", answerKind: "legal", persisted: true, partialCoverage: false, citationClaim: "c".repeat(43), expiresAt: Date.now() + 60_000,
    citations: value.citations.map(({ pageNumber }) => ({ label: `Labour Act, page ${pageNumber}`, jurisdictionId: PILOT_CATALOG.jurisdictionId,
      jurisdictionName: "Ghana", jurisdictionKind: "geographic", relation: "selected" })) }; });
  const deps: ReviewedEmploymentDependencies = { authority: { resolve }, draft: { draft }, verifier: createGeminiEvaluationVerifier({ interactions: { create } }), commit };
  const input = { externalId: "chat", jurisdictionId: PILOT_CATALOG.jurisdictionId, callsApproved: true,
    selection: { status: "selected" as const, question: pilot.question, facts: pilot.facts, requests: pilot.requests, evidence: evidence.evidence, topics: [] },
    requestStartedAt: Date.now() };
  return { input, deps, events, resolve, draft, create, commit, grant };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("normal reviewed employment chat", () => {
  it("retains only immutable numeric provider metadata on a verified result", async () => {
    const f = fixture();
    const timingMs = { preparation: 3, provider: 101, validation: 4, total: 108 };
    const usage = { total_input_tokens: 35, total_output_tokens: 9 };
    f.draft.mockResolvedValue({ status: "drafted", candidate, productionEligible: false, attemptCount: 1, timingMs, usage });
    const original = f.create.getMockImplementation()!;
    f.create.mockImplementation(async (...args) => ({ ...await original(...args), usage: { total_input_tokens: 80, total_output_tokens: 12 } } as Interactions.Interaction));
    const result = await createReviewedEmploymentChat(f.deps).run(f.input);
    expect(result).toMatchObject({ status: "verified", diagnostics: { version: 1, stage: "complete", reason: "verified",
      draft: { attemptCount: 1, timingMs, usage }, verifier: { attemptCount: 1, responseStatus: "completed", timingMs: { total: expect.any(Number) },
        usage: { total_input_tokens: 80, total_output_tokens: 12 } } } });
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/PRIVATE|Labour Act|fileSearchStores|sourceId|candidate|facts|question/);
    expect(Object.isFrozen(result.diagnostics)).toBe(true); expect(Object.isFrozen(result.diagnostics.draft)).toBe(true);
    expect(Object.isFrozen(result.diagnostics.draft.timingMs)).toBe(true); expect(Object.isFrozen(result.diagnostics.draft.usage)).toBe(true);
    timingMs.provider = 999; usage.total_input_tokens = 999;
    expect(result.diagnostics.draft.timingMs?.provider).toBe(101); expect(result.diagnostics.draft.usage?.total_input_tokens).toBe(35);
  });
  it.each(["provider_error", "incomplete_response", "limit_exceeded"] as const)("preserves the closed draft reason %s and returned attempt metadata", async reason => {
    const f = fixture(); f.draft.mockResolvedValue({ status: "blocked", reason, productionEligible: false, attemptCount: reason === "limit_exceeded" ? 0 : 1,
      timingMs: { preparation: 7, provider: 8, validation: 9, total: 24 } });
    const result = await createReviewedEmploymentChat(f.deps).run(f.input);
    expect(result).toMatchObject({ status: "blocked", reason: "draft_blocked", diagnostics: { stage: "draft", reason,
      draft: { attemptCount: reason === "limit_exceeded" ? 0 : 1, timingMs: { total: 24 } }, verifier: { attemptCount: null } } });
    expect(result.diagnostics.draft).not.toHaveProperty("usage"); expect(f.create).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  });
  it("preserves an actual verifier transport shape failure instead of only gate rejection", async () => {
    const f = fixture(); f.create.mockResolvedValue({ status: "in_progress", usage: { total_input_tokens: 42 } } as Interactions.Interaction);
    const result = await createReviewedEmploymentChat(f.deps).run(f.input);
    expect(result).toMatchObject({ status: "blocked", reason: "verification_blocked", diagnostics: { stage: "verifier", reason: "incomplete_response",
      gateReason: "verification_rejected", verifier: { attemptCount: 1, responseStatus: "in_progress", usage: { total_input_tokens: 42 }, timingMs: { total: expect.any(Number) } } } });
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.commit).not.toHaveBeenCalled();
  });
  it("distinguishes initial, pre-verifier and post-verifier authority failures without source identifiers", async () => {
    for (const [successfulReads, stage, gateReason] of [[0, "initial_authority", undefined], [1, "verification_authority_before", "authority_unavailable"], [2, "verification_authority_after", "authority_changed"]] as const) {
      const f = fixture(); f.resolve.mockReset();
      for (let i = 0; i < successfulReads; i++) f.resolve.mockResolvedValueOnce(f.grant);
      f.resolve.mockResolvedValue({ status: "unavailable", reason: "catalog_mismatch", productionEligible: false } as never);
      const result = await createReviewedEmploymentChat(f.deps).run(f.input);
      expect(result).toMatchObject({ status: "blocked", diagnostics: { stage, reason: "catalog_mismatch", ...(gateReason ? { gateReason } : {}) } });
      expect(JSON.stringify(result.diagnostics)).not.toContain(PILOT_IDENTITY.sourceId);
      expect(f.create).toHaveBeenCalledTimes(successfulReads === 2 ? 1 : 0); expect(f.commit).not.toHaveBeenCalled();
    }
  });
  it("identifies evidence projection mismatch before any dependency is invoked", async () => {
    const f = fixture(); const selection = JSON.parse(JSON.stringify(f.input.selection)); selection.evidence.passages[0].text += "PRIVATE mutation";
    expect(await createReviewedEmploymentChat(f.deps).run({ ...f.input, selection })).toMatchObject({ status: "blocked",
      diagnostics: { stage: "evidence", reason: "evidence_changed", draft: { attemptCount: null }, verifier: { attemptCount: null } } });
    expect(f.events).toEqual([]);
  });
  it("keeps attempt and usage unknown after a thrown dependency and strips its private error", async () => {
    const f = fixture(); f.draft.mockRejectedValue(new Error("PRIVATE question and credential"));
    const result = await createReviewedEmploymentChat(f.deps).run(f.input);
    expect(result).toMatchObject({ diagnostics: { stage: "draft", reason: "dependency_failed", draft: { attemptCount: null } }, callCounts: { draftInvocations: 1 } });
    expect(result.diagnostics.draft).not.toHaveProperty("timingMs"); expect(result.diagnostics.draft).not.toHaveProperty("usage");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("keeps a thrown verifier callback distinct from the gate's unavailable result", async () => {
    const f = fixture(); const deps = { ...f.deps, verifier: { evaluate: vi.fn().mockRejectedValue(new Error("PRIVATE verifier exception")) } };
    const result = await createReviewedEmploymentChat(deps).run(f.input);
    expect(result).toMatchObject({ reason: "verification_blocked", diagnostics: { stage: "verifier", reason: "dependency_failed", gateReason: "verification_unavailable",
      callCounts: { draftInvocations: 1, verifierInvocations: 1 }, verifier: { attemptCount: null } } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE"); expect(f.commit).not.toHaveBeenCalled();
  });
  it("identifies input rejected by the real verification gate before invoking the verifier", async () => {
    const f = fixture();
    const result = await createReviewedEmploymentChat(f.deps).run({ ...f.input, selection: { ...f.input.selection, facts: "x".repeat(32 * 1024 + 1) } });
    expect(result).toMatchObject({ reason: "verification_blocked", diagnostics: { stage: "verification_gate", reason: "invalid_input", gateReason: "invalid_input",
      callCounts: { draftInvocations: 1, verifierInvocations: 0 }, verifier: { attemptCount: null } } });
    expect(f.create).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  });
  it("projects only closed diagnostics for server logs, rejecting unknown labels and stripping private extras", () => {
    const value = { version: 1, stage: "verifier", reason: "invalid_verdict", gateReason: "verification_rejected",
      callCounts: { draftInvocations: 1, verifierInvocations: 1, question: "PRIVATE" },
      draft: { attemptCount: 1, timingMs: { preparation: 1, provider: 2, validation: 3, total: 6, sourceId: "PRIVATE" },
        usage: { total_input_tokens: 12, private: "PRIVATE" }, candidate: "PRIVATE" },
      verifier: { attemptCount: null }, error: "PRIVATE" };
    const projected = projectReviewedEmploymentDiagnostics(value);
    expect(projected).toEqual({ version: 1, stage: "verifier", reason: "invalid_verdict", gateReason: "verification_rejected",
      callCounts: { draftInvocations: 1, verifierInvocations: 1 }, draft: { attemptCount: 1,
        timingMs: { preparation: 1, provider: 2, validation: 3, total: 6 }, usage: { total_input_tokens: 12 } }, verifier: { attemptCount: null } });
    expect(Object.isFrozen(projected?.callCounts)).toBe(true); expect(JSON.stringify(projected)).not.toContain("PRIVATE");
    for (const change of [{ stage: "PRIVATE" }, { reason: "PRIVATE" }, { gateReason: "PRIVATE" },
      { callCounts: { draftInvocations: 2, verifierInvocations: 0 } }, { version: 2 }]) {
      expect(projectReviewedEmploymentDiagnostics({ ...value, ...change })).toBeUndefined();
    }
  });
  it("preserves only normalized response statuses and reads the status field once", () => {
    for (const status of ["completed", "incomplete", "budget_exceeded", "queued", "missing", "unknown", "PRIVATE status", undefined]) {
      let reads = 0;
      const projected = projectReviewedEmploymentDiagnostics({ version: 1, stage: "verifier", reason: "incomplete_response",
        callCounts: { draftInvocations: 1, verifierInvocations: 1 }, draft: { attemptCount: 1 }, verifier: {
          attemptCount: 1, get responseStatus() { reads++; return reads === 1 ? status : "PRIVATE second read"; },
          finish_reason: "PRIVATE", incomplete_details: { reason: "PRIVATE" },
        } });
      expect(reads).toBe(1);
      if (status === undefined) expect(projected?.verifier).not.toHaveProperty("responseStatus");
      else expect(projected?.verifier.responseStatus).toBe(status === "PRIVATE status" ? "unknown" : status);
      expect(JSON.stringify(projected)).not.toContain("PRIVATE");
      expect(Object.isFrozen(projected?.verifier)).toBe(true);
    }
  });
  it("separates commit exceptions from malformed persistence acknowledgements", async () => {
    const thrown = fixture(); thrown.commit.mockRejectedValue(new Error("PRIVATE backend error"));
    expect(await createReviewedEmploymentChat(thrown.deps).run(thrown.input)).toMatchObject({ reason: "commit_failed", diagnostics: { stage: "commit", reason: "dependency_failed" } });
    const malformed = fixture(); malformed.commit.mockResolvedValue({ status: "completed", persisted: false } as never);
    expect(await createReviewedEmploymentChat(malformed.deps).run(malformed.input)).toMatchObject({ reason: "commit_failed", diagnostics: { stage: "commit", reason: "invalid_result" } });
  });
  it("projects untrusted callback diagnostics through closed reason and numeric allowlists", async () => {
    const f = fixture(); f.draft.mockResolvedValue({ status: "blocked", reason: "PRIVATE callback error", attemptCount: "PRIVATE", productionEligible: false,
      timingMs: { preparation: 1, provider: -1, validation: 1, total: 2, private: "PRIVATE" },
      usage: { total_input_tokens: 9, total_output_tokens: NaN, private: "PRIVATE" }, question: "PRIVATE" } as never);
    const result = await createReviewedEmploymentChat(f.deps).run(f.input);
    expect(result).toMatchObject({ diagnostics: { stage: "draft", reason: "invalid_result", draft: { attemptCount: null } } });
    expect(result.diagnostics.draft).not.toHaveProperty("timingMs"); expect(result.diagnostics.draft).not.toHaveProperty("usage");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("freezes unknown hung-provider metadata at the deadline even if a late result arrives", async () => {
    vi.useFakeTimers(); const f = fixture(); let finish!: (value: Awaited<ReturnType<ReviewedEmploymentDependencies["draft"]["draft"]>>) => void;
    f.draft.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const running = createReviewedEmploymentChat(f.deps).run(f.input); await vi.advanceTimersByTimeAsync(60_000);
    const result = await running;
    expect(result).toMatchObject({ reason: "deadline_exceeded", diagnostics: { stage: "draft", reason: "deadline_exceeded", draft: { attemptCount: null } } });
    const snapshot = JSON.stringify(result);
    finish({ status: "blocked", reason: "aborted", productionEligible: false, attemptCount: 1, timingMs: { preparation: 0, provider: 60_000, validation: 0, total: 60_000 } });
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.stringify(result)).toBe(snapshot); expect(f.create).not.toHaveBeenCalled();
  });
  it("retains returned draft metadata even when the deadline guard withholds that result", async () => {
    vi.useFakeTimers(); const f = fixture();
    f.draft.mockImplementation(async () => {
      vi.setSystemTime(f.input.requestStartedAt + 60_000);
      return { status: "blocked", reason: "deadline_exceeded", productionEligible: false, attemptCount: 1,
        timingMs: { preparation: 1, provider: 59_999, validation: 0, total: 60_000 }, usage: { total_input_tokens: 10 } };
    });
    const result = await createReviewedEmploymentChat(f.deps).run(f.input);
    expect(result).toMatchObject({ reason: "deadline_exceeded", diagnostics: { stage: "draft", reason: "deadline_exceeded",
      draft: { attemptCount: 1, timingMs: { total: 60_000 }, usage: { total_input_tokens: 10 } } } });
    expect(f.create).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  });
  it("admits only explicit local development on port 3000 with a matching origin", () => {
    const request = (url = "http://localhost:3000/api/chat", origin = "http://localhost:3000") => new Request(url, { method: "POST", headers: { origin } });
    expect(isLocalReviewedEmploymentRequest(request(), localEnv)).toBe(true);
    for (const change of [{ NODE_ENV: "production" }, { VERCEL: "1" }, { LOCAL_REVIEWED_EMPLOYMENT_ENABLED: undefined }, { CONVEX_DEPLOYMENT: "prod:any" }]) {
      expect(isLocalReviewedEmploymentRequest(request(), { ...localEnv, ...change })).toBe(false);
    }
    expect(isLocalReviewedEmploymentRequest(request("http://localhost:3001/api/chat", "http://localhost:3001"), localEnv)).toBe(false);
    expect(isLocalReviewedEmploymentRequest(request(undefined, "https://external.test"), localEnv)).toBe(false);
  });
  it("keeps identical context and candidate bytes through verification, completion, persistence and release", async () => {
    const f = fixture(); const result = await createReviewedEmploymentChat(f.deps).run(f.input);
    expect(result).toMatchObject({ status: "verified", answer: candidate, persisted: true, productionEligible: false,
      callCounts: { draftInvocations: 1, verifierInvocations: 1 } });
    expect(f.events).toEqual(["authority", "draft", "authority", "verify", "authority", "commit"]);
    const draftInput = f.draft.mock.calls[0][0], verifierInput = JSON.parse(f.create.mock.calls[0][0].input as string);
    expect(verifierInput.question).toBe(draftInput.question); expect(verifierInput.facts).toBe(draftInput.facts);
    expect(f.commit.mock.calls[0][0].answer).toBe(candidate);
    expect(f.commit.mock.calls[0][0].citations.every(citation => citation.resourceId === PILOT_CATALOG.resourceId)).toBe(true);
  });
  it("does no authority, completion or paid work without paid-call approval", async () => {
    const f = fixture(); expect(await createReviewedEmploymentChat(f.deps).run({ ...f.input, callsApproved: false })).toMatchObject({ status: "blocked", reason: "calls_not_enabled" });
    expect(f.events).toEqual([]);
  });
  it("withholds all draft text after atomic completion/persistence fails", async () => {
    const f = fixture(); f.commit.mockRejectedValue(new Error("PRIVATE failure"));
    const result = await createReviewedEmploymentChat(f.deps).run(f.input);
    expect(result.status).toBe("blocked"); expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("rechecks authority after verification and rejects revocation before completion", async () => {
    const f = fixture(); f.resolve.mockResolvedValueOnce(f.grant).mockResolvedValueOnce(f.grant)
      .mockResolvedValueOnce({ status: "unavailable", reason: "authority_unavailable", productionEligible: false } as never);
    expect(await createReviewedEmploymentChat(f.deps).run(f.input)).toMatchObject({ status: "blocked", reason: "verification_blocked" });
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("releases a hung draft waiter at the original 60 second cutoff without another call", async () => {
    vi.useFakeTimers(); const f = fixture(); f.draft.mockImplementation(() => new Promise(() => {}));
    const running = createReviewedEmploymentChat(f.deps).run(f.input); await vi.advanceTimersByTimeAsync(60_000);
    expect(await running).toMatchObject({ status: "blocked", reason: "deadline_exceeded" });
    expect(f.create).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  });
  it("releases a verifier that ignores cancellation at the original 85 second cutoff", async () => {
    vi.useFakeTimers(); const f = fixture(); f.create.mockImplementation(() => new Promise(() => {}));
    const running = createReviewedEmploymentChat(f.deps).run(f.input); await vi.advanceTimersByTimeAsync(85_000);
    expect(await running).toMatchObject({ status: "blocked", reason: "deadline_exceeded", callCounts: { draftInvocations: 1, verifierInvocations: 1 } });
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("does not dispatch a replacement when the draft or verifier fails", async () => {
    const draftFailure = fixture(); draftFailure.draft.mockRejectedValue(new Error("PRIVATE provider failure"));
    expect(await createReviewedEmploymentChat(draftFailure.deps).run(draftFailure.input)).toMatchObject({ status: "blocked", reason: "draft_blocked" });
    expect(draftFailure.create).not.toHaveBeenCalled(); expect(draftFailure.commit).not.toHaveBeenCalled();
    const verifierFailure = fixture(); verifierFailure.create.mockRejectedValue(new Error("PRIVATE provider failure"));
    expect(await createReviewedEmploymentChat(verifierFailure.deps).run(verifierFailure.input)).toMatchObject({ status: "blocked", reason: "verification_blocked" });
    expect(verifierFailure.draft).toHaveBeenCalledTimes(1); expect(verifierFailure.create).toHaveBeenCalledTimes(1); expect(verifierFailure.commit).not.toHaveBeenCalled();
  });
  it("refuses a changed evidence projection before authority or paid dispatch", async () => {
    const f = fixture(); const changed = JSON.parse(JSON.stringify(f.input)); changed.selection.evidence.passages[0].text += " forged text";
    expect(await createReviewedEmploymentChat(f.deps).run(changed)).toMatchObject({ status: "blocked", reason: "evidence_unavailable" }); expect(f.events).toEqual([]);
  });
  it("honors cancellation before any work and while waiting for a provider", async () => {
    const pre = fixture(), already = new AbortController(); already.abort();
    expect(await createReviewedEmploymentChat(pre.deps).run({ ...pre.input, signal: already.signal })).toMatchObject({ reason: "aborted" }); expect(pre.events).toEqual([]);
    const f = fixture(), controller = new AbortController(); f.draft.mockImplementation(() => new Promise(() => {}));
    const running = createReviewedEmploymentChat(f.deps).run({ ...f.input, signal: controller.signal });
    await vi.waitFor(() => expect(f.draft).toHaveBeenCalledTimes(1)); controller.abort();
    expect(await running).toMatchObject({ status: "blocked", reason: "aborted" }); expect(f.create).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  });
  it("keeps completion and persistence inside the original 110 second terminal reserve", async () => {
    vi.useFakeTimers(); const f = fixture(); f.commit.mockImplementation(() => new Promise(() => {}));
    const running = createReviewedEmploymentChat(f.deps).run(f.input); await vi.advanceTimersByTimeAsync(110_000);
    expect(await running).toMatchObject({ status: "blocked", reason: "deadline_exceeded" }); expect(f.commit).toHaveBeenCalledTimes(1);
  });
  it("does not release a completion unless atomic persistence is explicitly confirmed", async () => {
    const f = fixture(); const original = f.commit.getMockImplementation()!;
    f.commit.mockImplementation(async value => ({ ...await original(value), persisted: false } as never));
    expect(await createReviewedEmploymentChat(f.deps).run(f.input)).toMatchObject({ status: "blocked", reason: "commit_failed" });
  });
});
