// @vitest-environment node
// Stage annotations are authored fixtures, never evidence of model reasoning.
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectEmploymentEvidence } from "./employment-evidence";
import { resolveEvaluationEvidence } from "./evidence";
import { getPilotCase, PILOT_CATALOG, PILOT_IDENTITY, PILOT_REGISTRY } from "./reviewed-source-cases";
import { createReviewedEmploymentChat, type ReviewedEmploymentDependencies } from "./reviewed-employment-chat";
import { createReviewedSplitVerifier } from "./reviewed-split-verifier";
import { caseInput, type CaseId } from "./test-fixtures/reviewed-request-catalog";
import { authoredStage } from "./test-fixtures/reviewed-answer-fixtures";
import { prepareSplitInput, type StageRequest, type SplitThinkingPolicy } from "./split-verification/contracts";
import type { SplitRunInput, StageExecutor } from "./split-verification/runner";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function response(request: StageRequest) {
  return { binding: request.binding, status: "completed", json: JSON.stringify(authoredStage(request)),
    usage: { input: 10, output: 20, thought: 30 } };
}

function fixture(caseId: CaseId = "nine-month-control", thinkingPolicy?: SplitThinkingPolicy) {
  const source = caseInput(caseId);
  const selection = selectEmploymentEvidence({ question: source.question, history: [], attachments: [] });
  if (selection.status !== "selected") throw new Error("reviewed fixture unavailable");
  const candidate = source.candidate;
  const events: string[] = [];
  const grant = { status: "authorized" as const, identities: [PILOT_IDENTITY], productionEligible: false as const,
    applicability: "source_edition_only" as const, requiresFinalAtomicCompletion: true as const,
    citationIdentity: { ...PILOT_CATALOG, providerStoreName: "fileSearchStores/fixture" },
    manifest: { authorizedScopeSize: 1, partialCoverage: false, stores: [{ jurisdictionId: PILOT_CATALOG.jurisdictionId,
      name: "Ghana", kind: "geographic" as const, relation: "selected" as const, storeName: "fileSearchStores/fixture" }] } };
  const resolve = vi.fn<ReviewedEmploymentDependencies["authority"]["resolve"]>(async () => {
    events.push("authority"); return grant;
  });
  const draft = vi.fn<ReviewedEmploymentDependencies["draft"]["draft"]>(async () => {
    events.push("draft");
    return { status: "drafted", candidate, productionEligible: false, attemptCount: 1,
      timingMs: { preparation: 0, provider: 0, validation: 0, total: 0 } };
  });
  const execute = vi.fn<StageExecutor>(async request => { events.push(request.stage); return response(request); });
  const createExecutor = vi.fn<(input: SplitRunInput) => StageExecutor>(() => execute);
  const verifier = createReviewedSplitVerifier({ createExecutor, thinkingPolicy });
  const commit = vi.fn<ReviewedEmploymentDependencies["commit"]>(async value => {
    events.push("commit");
    return { status: "completed", outcome: "success", answerKind: "legal", persisted: true,
      partialCoverage: false, citationClaim: "c".repeat(43), expiresAt: Date.now() + 60_000,
      citations: value.citations.map(({ pageNumber }) => ({ label: `Labour Act, page ${pageNumber}`,
        jurisdictionId: PILOT_CATALOG.jurisdictionId, jurisdictionName: "Ghana", jurisdictionKind: "geographic", relation: "selected" })) };
  });
  const deps: ReviewedEmploymentDependencies = { authority: { resolve }, draft: { draft }, verifier, commit };
  const input = { externalId: "split-chat", jurisdictionId: PILOT_CATALOG.jurisdictionId, callsApproved: true,
    selection, requestStartedAt: Date.now(), requestStartedMonotonic: performance.now() };
  return { source, candidate, events, grant, resolve, draft, execute, createExecutor, verifier, commit, deps, input };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("reviewed employment chat with the actual split verifier", () => {
  it.each([null, "low", "unknown"])("rejects unknown server policy %s before constructing an executor or saving", async thinkingPolicy => {
    const f = fixture();
    const verifier = createReviewedSplitVerifier({ createExecutor: f.createExecutor, thinkingPolicy: thinkingPolicy as never });
    const result = await createReviewedEmploymentChat({ ...f.deps, verifier }).run(f.input);
    expect(result).toMatchObject({ status: "blocked", reason: "verification_blocked" });
    expect(f.createExecutor).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("uses low inventory and medium audits for the candidate without changing bound context or atomic persistence", async () => {
    const f = fixture("nine-month-control", "inventory_low");
    const result = await createReviewedEmploymentChat(f.deps).run(f.input);
    expect(result).toMatchObject({ status: "verified", answer: f.candidate, persisted: true });
    expect(f.execute.mock.calls.map(([request]) => request.generation_config)).toEqual([
      { thinking_level: "low", max_output_tokens: 8192 },
      { thinking_level: "medium", max_output_tokens: 8192 },
      { thinking_level: "medium", max_output_tokens: 8192 },
    ]);
    const admitted = f.createExecutor.mock.calls[0][0];
    expect(admitted.evidence).toEqual(f.source.evidence);
    const prepared = prepareSplitInput(admitted)!;
    for (const [request] of f.execute.mock.calls) {
      expect(request.deadlineAt).toBe(f.input.requestStartedAt + 85_000);
      expect(request.data.context.candidate).toBe(f.candidate);
      expect(request.data.context).toEqual(prepared.context);
      expect(request.binding.contextSha256).toBe(prepared.contextSha256);
    }
    expect(f.events).toEqual(["authority", "draft", "authority", "inventory", "consent", "overtime", "authority", "commit"]);
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(f.commit.mock.calls[0][0].answer).toBe(f.candidate);
  });

  it("keeps semantic withholding for the low-inventory candidate without dispatching audits or saving", async () => {
    const f = fixture("missing-consent", "inventory_low");
    const result = await createReviewedEmploymentChat(f.deps).run(f.input);
    expect(result).toMatchObject({ status: "blocked", reason: "verification_blocked" });
    expect(f.execute.mock.calls.map(([request]) => request.generation_config.thinking_level)).toEqual(["low"]);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("rechecks authority around three stages and atomically persists the exact verified candidate and citations", async () => {
    const f = fixture();
    const result = await createReviewedEmploymentChat(f.deps).run(f.input);
    expect(f.verifier.kind).toBe("split");
    expect(result).toMatchObject({ status: "verified", answer: f.candidate, persisted: true, productionEligible: false,
      callCounts: { draftInvocations: 1, verifierInvocations: 1 }, diagnostics: {
        stage: "complete", reason: "verified", verifier: { attemptCount: null }, splitVerifier: {
          kind: "split", decision: "pass", reason: "verified", executorInvocations: 3, elapsedMs: expect.any(Number),
          stages: [
            { stage: "inventory", status: "passed", dispatched: true, elapsedMs: expect.any(Number), usage: { input: 10, output: 20, thought: 30 } },
            { stage: "consent", status: "passed", dispatched: true, elapsedMs: expect.any(Number), usage: { input: 10, output: 20, thought: 30 } },
            { stage: "overtime", status: "passed", dispatched: true, elapsedMs: expect.any(Number), usage: { input: 10, output: 20, thought: 30 } },
          ], usage: { coverage: "complete", knownStages: 3, dispatchedStages: 3, knownSubtotal: { input: 30, output: 60, thought: 90 } },
        },
      } });
    expect(f.events).toEqual(["authority", "draft", "authority", "inventory", "consent", "overtime", "authority", "commit"]);
    expect(f.createExecutor).toHaveBeenCalledTimes(1);
    const verifierInput = f.createExecutor.mock.calls[0][0];
    expect(verifierInput).toMatchObject({ question: f.input.selection.question, facts: f.input.selection.facts,
      candidate: f.candidate, evidence: f.source.evidence, requestStartedAt: f.input.requestStartedAt,
      requestStartedMonotonic: f.input.requestStartedMonotonic });
    expect(f.draft.mock.calls[0][0]).toMatchObject({ question: verifierInput.question, facts: verifierInput.facts, evidence: verifierInput.evidence });
    for (const [request] of f.execute.mock.calls) {
      expect(request.deadlineAt).toBe(f.input.requestStartedAt + 85_000);
      expect(request.data.context.candidate).toBe(f.candidate);
      expect(request.data.context.question).toBe(verifierInput.question);
      expect(request.data.context.facts).toBe(verifierInput.facts);
    }
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(f.commit.mock.calls[0][0]).toMatchObject({ answer: f.candidate, manifest: f.grant.manifest });
    const pages = [...new Set(f.source.evidence.passages.map(passage => passage.pdfOrdinal))].sort((a, b) => a - b);
    expect(f.commit.mock.calls[0][0].citations).toEqual(pages.map(pageNumber => ({ ...f.grant.citationIdentity, pageNumber })));
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(JSON.stringify(result.diagnostics)).not.toContain(f.candidate);
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/fileSearchStores|sourceId|question|facts/);
  });

  it("keeps a valid negative inventory distinct from failure and never commits its candidate", async () => {
    const f = fixture("missing-consent");
    const result = await createReviewedEmploymentChat(f.deps).run(f.input);
    expect(result).toMatchObject({ status: "blocked", reason: "verification_blocked", diagnostics: {
      verifier: { attemptCount: null }, splitVerifier: { kind: "split", decision: "withhold", reason: "stage_rejected",
        executorInvocations: 1, stages: [
          { stage: "inventory", status: "withheld", dispatched: true },
          { stage: "consent", status: "not_started", dispatched: false },
          { stage: "overtime", status: "not_started", dispatched: false },
        ], usage: { coverage: "complete", knownStages: 1, dispatchedStages: 1 } },
    } });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.commit).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("answer");
    expect(JSON.stringify(result)).not.toContain(f.candidate);
  });

  it("reports transport failure as provider_error with unknown usage instead of a correct negative", async () => {
    const f = fixture(); f.execute.mockRejectedValue(new Error("PRIVATE transport detail"));
    const result = await createReviewedEmploymentChat(f.deps).run(f.input);
    expect(result).toMatchObject({ status: "blocked", reason: "verification_blocked", diagnostics: {
      verifier: { attemptCount: null }, splitVerifier: { decision: "withhold", reason: "provider_error", executorInvocations: 1,
        usage: { coverage: "unknown", knownStages: 0, dispatchedStages: 1, knownSubtotal: { input: 0, output: 0, thought: 0 } } },
    } });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.commit).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|transport detail/);
    expect(result).not.toHaveProperty("answer");
  });

  it("cancels an ignoring stage without a retry, audit or atomic commit", async () => {
    const f = fixture(), controller = new AbortController(), entered = deferred<AbortSignal>();
    f.execute.mockImplementation((_request, signal) => { entered.resolve(signal); return new Promise(() => {}); });
    const pending = createReviewedEmploymentChat(f.deps).run({ ...f.input, signal: controller.signal });
    const stageSignal = await entered.promise;
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ status: "blocked", reason: "aborted", callCounts: { draftInvocations: 1, verifierInvocations: 1 } });
    expect(stageSignal.aborted).toBe(true);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.commit).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("answer");
  });

  it("uses the original route wall and monotonic origins for the 85-second cutoff", async () => {
    vi.useFakeTimers();
    let monotonic = 100_000;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const f = fixture(), entered = deferred<void>();
    f.input.requestStartedAt -= 20_000;
    f.input.requestStartedMonotonic -= 20_000;
    f.execute.mockImplementation(() => { entered.resolve(); return new Promise(() => {}); });
    let settled = false;
    const pending = createReviewedEmploymentChat(f.deps).run(f.input);
    void pending.then(() => { settled = true; });
    await entered.promise;
    expect(f.createExecutor.mock.calls[0][0]).toMatchObject({ requestStartedAt: f.input.requestStartedAt,
      requestStartedMonotonic: 80_000 });
    expect(f.execute.mock.calls[0][0].deadlineAt).toBe(f.input.requestStartedAt + 85_000);
    monotonic += 64_999;
    await vi.advanceTimersByTimeAsync(64_999);
    expect(settled).toBe(false);
    monotonic += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: "blocked", reason: "deadline_exceeded" });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("retains completed inventory and cancelled audit timings when the outer 85-second timeout wins", async () => {
    vi.useFakeTimers(); let monotonic = 100_000;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const f = fixture(), late = deferred<void>(), draft = f.draft.getMockImplementation()!;
    let authorityCalls = 0;
    f.resolve.mockImplementation(async () => {
      if (++authorityCalls === 1) await new Promise<void>(resolve => setTimeout(resolve, 9700));
      return f.grant;
    });
    f.draft.mockImplementation(async input => {
      await new Promise<void>(resolve => setTimeout(resolve, 15796));
      return { ...await draft(input), timingMs: { preparation: 5, provider: 15786, validation: 3, total: 15796 } };
    });
    f.execute.mockImplementation(async request => {
      if (request.stage === "inventory") await new Promise<void>(resolve => setTimeout(resolve, 56300));
      else await late.promise;
      return response(request);
    });
    let settled = false; const pending = createReviewedEmploymentChat(f.deps).run(f.input);
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    for (const elapsed of [9700, 15796, 56300, 3203]) { monotonic += elapsed; await vi.advanceTimersByTimeAsync(elapsed); }
    expect(settled).toBe(false); expect(f.execute).toHaveBeenCalledTimes(3);
    monotonic++; await vi.advanceTimersByTimeAsync(1);
    const result = await pending, serialized = JSON.stringify(result.diagnostics);
    expect(result).toMatchObject({ status: "blocked", reason: "deadline_exceeded", diagnostics: { stage: "verifier", reason: "deadline_exceeded",
      draft: { timingMs: { total: 15796 } }, splitVerifier: { decision: "withhold", executorInvocations: 3, elapsedMs: 59504,
        stages: [{ stage: "inventory", status: "passed", dispatched: true, elapsedMs: 56300, usage: { input: 10, output: 20, thought: 30 } },
          { stage: "consent", status: "cancelled", dispatched: true, elapsedMs: 3204 },
          { stage: "overtime", status: "cancelled", dispatched: true, elapsedMs: 3204 }],
        usage: { coverage: "partial", knownStages: 1, dispatchedStages: 3, knownSubtotal: { input: 10, output: 20, thought: 30 } } } } });
    expect(result).not.toHaveProperty("answer"); expect(f.commit).not.toHaveBeenCalled();
    expect(Object.isFrozen(result.diagnostics.splitVerifier?.stages[1])).toBe(true);
    expect(serialized).not.toMatch(/candidate|question|facts|sourceId|fileSearchStores/);
    late.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(result.diagnostics)).toBe(serialized); expect(f.commit).not.toHaveBeenCalled();
    expect(f.execute.mock.calls.every(([request, signal]) => request.deadlineAt === f.input.requestStartedAt + 85000 && signal.aborted)).toBe(true);
  });

  it("requires the actual original monotonic origin for split verification before paid work", async () => {
    const f = fixture();
    const { requestStartedMonotonic: _omitted, ...legacyInput } = f.input;
    const result = await createReviewedEmploymentChat(f.deps).run(legacyInput);
    expect(result).toMatchObject({ status: "blocked", reason: "invalid_request" });
    expect(f.events).toEqual([]);
    expect(f.createExecutor).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("rejects an unsupported source-condition set before drafting or creating a stage executor", async () => {
    const f = fixture(), pilot = getPilotCase("pilot-notice")!;
    const resolution = resolveEvaluationEvidence(PILOT_REGISTRY, pilot.requests);
    if (resolution.status !== "resolved") throw new Error("notice fixture unavailable");
    const result = await createReviewedEmploymentChat(f.deps).run({ ...f.input, selection: {
      status: "selected", question: pilot.question, facts: pilot.facts, requests: pilot.requests, evidence: resolution.evidence,
    } });
    expect(result).toMatchObject({ status: "blocked", reason: "evidence_unavailable",
      diagnostics: { stage: "evidence", reason: "invalid_input" } });
    expect(f.events).toEqual([]);
    expect(f.draft).not.toHaveBeenCalled();
    expect(f.createExecutor).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("does not release a three-stage pass without an explicit atomic persistence acknowledgement", async () => {
    const f = fixture(), commit = f.commit.getMockImplementation()!;
    f.commit.mockImplementation(async value => ({ ...await commit(value), persisted: false } as never));
    const result = await createReviewedEmploymentChat(f.deps).run(f.input);
    expect(result).toMatchObject({ status: "blocked", reason: "commit_failed", diagnostics: {
      stage: "commit", reason: "invalid_result", splitVerifier: { decision: "pass", executorInvocations: 3 },
    } });
    expect(f.execute).toHaveBeenCalledTimes(3);
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(f.commit.mock.calls[0][0].answer).toBe(f.candidate);
    expect(result).not.toHaveProperty("answer");
    expect(JSON.stringify(result)).not.toContain(f.candidate);
  });

  it("withholds a three-stage pass if source authority changes before atomic completion", async () => {
    const f = fixture(); let reads = 0;
    f.resolve.mockImplementation(async () => {
      f.events.push("authority");
      return ++reads === 3 ? { status: "unavailable", reason: "catalog_mismatch", productionEligible: false } : f.grant;
    });
    const result = await createReviewedEmploymentChat(f.deps).run(f.input);
    expect(result).toMatchObject({ status: "blocked", reason: "verification_blocked", diagnostics: {
      stage: "verification_authority_after", reason: "catalog_mismatch", gateReason: "authority_changed",
      splitVerifier: { decision: "pass", executorInvocations: 3 },
    } });
    expect(f.events).toEqual(["authority", "draft", "authority", "inventory", "consent", "overtime", "authority"]);
    expect(f.commit).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("answer");
  });
});
