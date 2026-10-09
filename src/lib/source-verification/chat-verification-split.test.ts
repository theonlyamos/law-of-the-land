// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createChatVerificationGate, type ChatVerificationDependencies } from "./chat-verification-gate";
import { caseInput } from "./test-fixtures/reviewed-request-catalog";
import { selectEmploymentEvidence } from "./employment-evidence";
import { PILOT_IDENTITY, PILOT_REGISTRY } from "./reviewed-source-cases";
import { prepareSplitInput } from "./split-verification/contracts";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture(timingPolicy?: "standard" | "background") {
  const source = caseInput("nine-month-control"), prepared = prepareSplitInput(source)!;
  const selection = selectEmploymentEvidence({ question: source.question, history: [], attachments: [] });
  if (selection.status !== "selected") throw new Error("authored fixture unavailable");
  const origin = Date.now(), mono = performance.now();
  const input = { kind: "legal" as const, question: source.question, facts: source.facts, candidate: source.candidate,
    requests: selection.requests, requestStartedAt: origin, requestStartedMonotonic: mono, deadlineAt: origin + 85_000 };
  const result = { purpose: "offline_split_verification_v1", productionEligible: false, runtimeEnabled: false, experimental: true,
    decision: "pass", reason: "verified", dispatchCount: 3, segmentCount: prepared.segments.length, claimCount: prepared.segments.length,
    elapsedMs: 3, stages: ["inventory", "consent", "overtime"].map(stage => ({ stage, status: "passed", dispatched: true,
      elapsedMs: 1, usage: { input: 10, output: 20, thought: 30 } })),
    usage: { coverage: "complete", knownStages: 3, dispatchedStages: 3, knownSubtotal: { input: 30, output: 60, thought: 90 } } };
  const verify = vi.fn(async (value: unknown) => { void value; return result; }), authority = vi.fn(async () => ({ status: "authorized" as const, identities: [PILOT_IDENTITY] }));
  const dependencies = { timingPolicy, registry: PILOT_REGISTRY, resolveAuthority: authority, verifier: { kind: "split" as const, verify } } as unknown as ChatVerificationDependencies;
  return { input, result, verify, authority, gate: createChatVerificationGate(dependencies) };
}
it("accepts an explicit complete split result while preserving fresh authority and exact candidate binding", async () => {
  const f = fixture(); expect(await f.gate.verify(f.input)).toMatchObject({ status: "pass", reason: "verified", segmentCount: 3 });
  expect(f.authority).toHaveBeenCalledTimes(2); expect(f.verify).toHaveBeenCalledTimes(1);
  expect(f.verify.mock.calls[0][0]).toMatchObject({ requestStartedAt: f.input.requestStartedAt,
    requestStartedMonotonic: f.input.requestStartedMonotonic, deadlineAt: f.input.deadlineAt, candidate: f.input.candidate });
});
it.each(["missing-audit", "wrong-order", "partial-usage", "bad-total", "unknown-field", "wrong-decision"])("rejects a claimed split pass with %s", async kind => {
  const f = fixture();
  if (kind === "missing-audit") f.result.stages.pop();
  if (kind === "wrong-order") f.result.stages.reverse();
  if (kind === "partial-usage") f.result.usage.coverage = "partial";
  if (kind === "bad-total") f.result.usage.knownSubtotal.input++;
  if (kind === "unknown-field") Object.assign(f.result, { privateText: "PRIVATE unsupported field" });
  if (kind === "wrong-decision") { f.result.decision = "withhold"; f.result.reason = "stage_rejected"; }
  expect(await f.gate.verify(f.input)).toMatchObject({ status: "withhold", reason: "verification_rejected" });
  expect(f.authority).toHaveBeenCalledTimes(1);
});
it("requires original monotonic timing for split mode before any authority or provider work", async () => {
  const f = fixture(); const { requestStartedMonotonic: _unused, ...input } = f.input; void _unused;
  expect(await f.gate.verify(input)).toMatchObject({ status: "withhold", reason: "invalid_deadline" });
  expect(f.authority).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
});
it("withholds revoked authority after a complete split pass", async () => {
  const f = fixture(); f.authority.mockResolvedValueOnce({ status: "authorized", identities: [PILOT_IDENTITY] })
    .mockResolvedValueOnce({ status: "authorized", identities: [] });
  expect(await f.gate.verify(f.input)).toMatchObject({ status: "withhold", reason: "authority_changed" });
});

it("captures queued background wall allowance into a fresh worker monotonic origin before wall rollback", async () => {
  vi.useFakeTimers(); let mono = 1000; vi.spyOn(performance, "now").mockImplementation(() => mono);
  const f = fixture("background"); f.input.requestStartedAt -= 40_000; f.input.deadlineAt = f.input.requestStartedAt + 240_000;
  f.verify.mockImplementation(async () => { mono += 200_000; vi.setSystemTime(f.input.requestStartedAt + 10_000); return f.result; });
  expect(await f.gate.verify(f.input)).toMatchObject({ status: "withhold", reason: "deadline_exceeded" });
  expect(f.authority).toHaveBeenCalledTimes(1);
});

it.each([null, "unknown"])("rejects invalid trusted gate policy %s before authority", async policy => {
  const f = fixture(); const authority = vi.fn(async () => ({ status: "authorized" as const, identities: [PILOT_IDENTITY] }));
  const gate = createChatVerificationGate({ registry: PILOT_REGISTRY, resolveAuthority: authority, timingPolicy: policy as never,
    verifier: { kind: "split", verify: f.verify } });
  expect(await gate.verify(f.input)).toMatchObject({ status: "withhold", reason: "invalid_input" });
  expect(authority).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
});
