// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReviewedEmploymentChat, type ReviewedEmploymentDependencies } from "./reviewed-employment-chat";
import { createReviewedSplitVerifier } from "./reviewed-split-verifier";
import { selectEmploymentEvidence } from "./employment-evidence";
import { PILOT_CATALOG, PILOT_IDENTITY } from "./reviewed-source-cases";
import { caseInput } from "./test-fixtures/reviewed-request-catalog";
import { authoredStage } from "./test-fixtures/reviewed-answer-fixtures";
import type { SplitRunInput, StageExecutor } from "./split-verification/runner";

function fixture(timingPolicy: unknown = "background") {
  const source = caseInput("nine-month-control");
  const selection = selectEmploymentEvidence({ question: source.question, history: [], attachments: [] });
  if (selection.status !== "selected") throw new Error("authored fixture unavailable");
  const grant = { status: "authorized" as const, identities: [PILOT_IDENTITY], productionEligible: false as const,
    applicability: "source_edition_only" as const, requiresFinalAtomicCompletion: true as const,
    citationIdentity: { ...PILOT_CATALOG, providerStoreName: "fileSearchStores/fixture" },
    manifest: { authorizedScopeSize: 1, partialCoverage: false, stores: [{ jurisdictionId: PILOT_CATALOG.jurisdictionId,
      name: "Ghana", kind: "geographic" as const, relation: "selected" as const, storeName: "fileSearchStores/fixture" }] } };
  const authority = vi.fn<ReviewedEmploymentDependencies["authority"]["resolve"]>(async () => grant);
  const draft = vi.fn<ReviewedEmploymentDependencies["draft"]["draft"]>(async () => ({ status: "drafted", candidate: source.candidate,
    productionEligible: false, attemptCount: 1, timingMs: { preparation: 0, provider: 0, validation: 0, total: 0 } }));
  const execute = vi.fn<StageExecutor>(async request => ({ binding: request.binding, status: "completed",
    json: JSON.stringify(authoredStage(request)), usage: { input: 10, output: 20, thought: 30 } }));
  const createExecutor = vi.fn<(input: SplitRunInput) => StageExecutor>(() => execute);
  const verifier = createReviewedSplitVerifier({ createExecutor, thinkingPolicy: "inventory_low", timingPolicy: timingPolicy as never });
  const commit = vi.fn<ReviewedEmploymentDependencies["commit"]>(async value => ({ status: "completed", outcome: "success", answerKind: "legal",
    persisted: true, partialCoverage: false, citationClaim: "c".repeat(43), expiresAt: Date.now() + 60_000,
    citations: value.citations.map(({ pageNumber }) => ({ label: `Labour Act, page ${pageNumber}`, jurisdictionId: PILOT_CATALOG.jurisdictionId,
      jurisdictionName: "Ghana", jurisdictionKind: "geographic", relation: "selected" })) }));
  const deps = { authority: { resolve: authority }, draft: { draft }, verifier, commit, timingPolicy: timingPolicy as never };
  const input = { externalId: "background-job", jurisdictionId: PILOT_CATALOG.jurisdictionId, callsApproved: true, selection,
    requestStartedAt: Date.now(), requestStartedMonotonic: performance.now() };
  return { source, authority, draft, execute, createExecutor, commit, deps, input };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("trusted reviewed background timing", () => {
  it("persists a complete semantic pass after 85 seconds using one original 240-second verification deadline", async () => {
    vi.useFakeTimers(); let mono = 100_000; vi.spyOn(performance, "now").mockImplementation(() => mono);
    const f = fixture(); const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (request, signal) => {
      if (request.stage === "inventory") { mono += 100_000; vi.setSystemTime(f.input.requestStartedAt + 100_000); }
      return original(request, signal);
    });
    const result = await createReviewedEmploymentChat(f.deps).run(f.input);
    expect(result).toMatchObject({ status: "verified", answer: f.source.candidate, persisted: true });
    expect(f.authority.mock.calls.map(([input]) => input.deadlineAt)).toEqual([
      f.input.requestStartedAt + 60_000, f.input.requestStartedAt + 240_000, f.input.requestStartedAt + 240_000,
    ]);
    expect(f.execute.mock.calls.map(([request]) => request.deadlineAt)).toEqual(Array(3).fill(f.input.requestStartedAt + 240_000));
    expect(f.execute.mock.calls.map(([request]) => request.generation_config)).toEqual([
      { thinking_level: "low", max_output_tokens: 8192 }, { thinking_level: "medium", max_output_tokens: 8192 }, { thinking_level: "medium", max_output_tokens: 8192 },
    ]);
    expect(f.commit).toHaveBeenCalledTimes(1);
  });

  it.each([null, "unknown", 240_000])("rejects an invalid trusted policy %s before authority, draft or verifier work", async policy => {
    const f = fixture(policy);
    expect(await createReviewedEmploymentChat(f.deps).run(f.input)).toMatchObject({ status: "blocked", reason: "invalid_request" });
    expect(f.authority).not.toHaveBeenCalled(); expect(f.draft).not.toHaveBeenCalled();
    expect(f.createExecutor).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  });

  it("captures the constructor policy once before asynchronous authority work", async () => {
    vi.useFakeTimers(); let mono = 100_000; vi.spyOn(performance, "now").mockImplementation(() => mono);
    const f = fixture(); let reads = 0;
    const deps = { ...f.deps, get timingPolicy() { reads++; return reads === 1 ? "background" as const : null as never; } };
    const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (request, signal) => {
      if (request.stage === "inventory") { mono += 100_000; vi.setSystemTime(f.input.requestStartedAt + 100_000); }
      return original(request, signal);
    });
    expect(await createReviewedEmploymentChat(deps).run(f.input)).toMatchObject({ status: "verified" });
    expect(reads).toBe(1);
  });

  it("keeps the original 60-second draft cap in background jobs", async () => {
    vi.useFakeTimers(); let mono = 100_000; vi.spyOn(performance, "now").mockImplementation(() => mono);
    const f = fixture(); f.input.requestStartedAt -= 20_000; f.input.requestStartedMonotonic -= 20_000;
    f.draft.mockImplementation(() => new Promise(() => {}));
    const pending = createReviewedEmploymentChat(f.deps).run(f.input);
    await vi.advanceTimersByTimeAsync(0); mono += 40_000; await vi.advanceTimersByTimeAsync(40_000);
    expect(await pending).toMatchObject({ status: "blocked", reason: "deadline_exceeded", diagnostics: { stage: "draft" } });
    expect(f.createExecutor).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  });

  it("withholds a semantic pass at the original 240-second deadline and never commits", async () => {
    vi.useFakeTimers(); let mono = 100_000; vi.spyOn(performance, "now").mockImplementation(() => mono);
    const f = fixture(); const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (request, signal) => {
      mono = f.input.requestStartedMonotonic + 240_000; vi.setSystemTime(f.input.requestStartedAt + 240_000);
      return original(request, signal);
    });
    expect(await createReviewedEmploymentChat(f.deps).run(f.input)).toMatchObject({ status: "blocked", reason: "deadline_exceeded" });
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("reserves terminal time to 270 seconds after a complete verification pass", async () => {
    vi.useFakeTimers(); let mono = 100_000; vi.spyOn(performance, "now").mockImplementation(() => mono);
    const f = fixture(); const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (request, signal) => {
      if (request.stage === "inventory") { mono += 100_000; vi.setSystemTime(f.input.requestStartedAt + 100_000); }
      return original(request, signal);
    });
    f.commit.mockImplementation(() => new Promise(() => {}));
    const pending = createReviewedEmploymentChat(f.deps).run(f.input);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.commit).toHaveBeenCalledTimes(1);
    mono += 170_000; await vi.advanceTimersByTimeAsync(170_000);
    expect(await pending).toMatchObject({ status: "blocked", reason: "deadline_exceeded", diagnostics: { stage: "commit" } });
  });
});

