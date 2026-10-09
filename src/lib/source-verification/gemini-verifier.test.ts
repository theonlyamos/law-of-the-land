// @vitest-environment node
import type { GoogleGenAI, Interactions } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiEvaluationVerifier, normalizeEvaluationResponseStatus, type GeminiEvaluationClient } from "./gemini-verifier";
import { EVALUATION_LIMITS, type EvaluationEvidence } from "./evidence";
import { buildEvaluationVerifierInput, EVALUATION_VERDICT_JSON_SCHEMA } from "./verdict";

// Authored synthetic data, never real user/provider output.
const evidence: EvaluationEvidence = { purpose: "offline_evaluation", productionEligible: false, passages: [] };
const input = () => ({ question: "Synthetic question", candidate: "An issue remains unresolved.", evidence, deadlineAt: Date.now() + 1000 });
const verdict = JSON.stringify({ decision: "pass", segments: [{ segmentId: "segment-1", claims: [
  { claimId: "private-generated-id", status: "evidence_gap", evidenceIds: [] },
] }] });
const output = (text = verdict): Interactions.ModelOutputStep => ({ type: "model_output", content: [{ type: "text", text }] });
const response = (overrides: Partial<Interactions.Interaction> = {}): Interactions.Interaction => ({ id: "private-interaction", status: "completed", steps: [output()], ...overrides });
function setup(value: unknown = response()) {
  const create = vi.fn<GeminiEvaluationClient["interactions"]["create"]>().mockResolvedValue(value as Interactions.Interaction);
  return { create, verifier: createGeminiEvaluationVerifier({ interactions: { create } }) };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded experimental Gemini verifier", () => {
  it("uses the SDK seam and exact independent non-stream request", async () => {
    // Compile-only assignment verifies compatibility with the actual installed client.
    const compatible = (client: GoogleGenAI): GeminiEvaluationClient => client;
    expect(compatible).toBeTypeOf("function");
    const { create, verifier } = setup(); const args = input();
    const result = await verifier.evaluate(args);
    const prepared = buildEvaluationVerifierInput(args);
    if (prepared.status !== "ready") throw new Error("fixture invalid");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toEqual({ model: "gemini-3.8-flash", input: prepared.prompt,
      system_instruction: prepared.systemInstruction, tools: [], store: false, stream: false,
      generation_config: { thinking_level: "medium", thinking_summaries: "none", tool_choice: "none", max_output_tokens: 8192 },
      response_format: { type: "text", mime_type: "application/json", schema: EVALUATION_VERDICT_JSON_SCHEMA } });
    expect(create.mock.calls[0][1]).toEqual({ maxRetries: 0, signal: expect.any(AbortSignal), timeout: expect.any(Number) });
    expect(result).toMatchObject({ purpose: "offline_evaluation", productionEligible: false, decision: "pass", reason: "verified", evaluated: true, attemptCount: 1, segmentCount: 1, claimCount: 1, responseStatus: "completed" });
    expect(JSON.stringify(result)).not.toMatch(/Synthetic|unresolved|private-/);
    expect(Object.keys(result).sort()).toEqual(["attemptCount", "claimCount", "decision", "evaluated", "productionEligible", "purpose", "reason", "responseStatus", "segmentCount", "timingMs"].sort());
    for (const value of Object.values(result.timingMs)) expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
  });
  it.each([0, -1, NaN, Infinity, 1.5])("rejects expired/invalid deadline %s without calls", async (deadlineAt) => {
    const { create, verifier } = setup(); const result = await verifier.evaluate({ ...input(), deadlineAt });
    expect(result).toMatchObject({ decision: "withhold", evaluated: false, reason: Number.isSafeInteger(deadlineAt) ? "deadline_exceeded" : "invalid_deadline" }); expect(create).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("responseStatus");
  });
  it("makes no call for pre-aborted input and omits abort reason", async () => {
    const { create, verifier } = setup(); const controller = new AbortController(); controller.abort("private-abort");
    expect(await verifier.evaluate({ ...input(), signal: controller.signal })).toMatchObject({ reason: "aborted", attemptCount: 0 });
    expect(create).not.toHaveBeenCalled();
  });
  it("checks the original deadline after preparation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); const { create, verifier } = setup(); const args = input();
    Object.defineProperty(args, "question", { get: () => { vi.setSystemTime(2000); return "Synthetic"; } });
    expect(await verifier.evaluate(args)).toMatchObject({ reason: "deadline_exceeded", attemptCount: 0 });
    expect(create).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("uses only time remaining after preparation even when provider ignores abort", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); const { create, verifier } = setup(); const args = input();
    Object.defineProperty(args, "question", { get: () => { vi.setSystemTime(1900); return "Synthetic"; } });
    create.mockImplementation(() => new Promise(() => {})); const pending = verifier.evaluate(args);
    expect(create.mock.calls[0][1].timeout).toBe(100);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result).toMatchObject({ reason: "deadline_exceeded", evaluated: false, attemptCount: 1 });
    expect(result).not.toHaveProperty("responseStatus");
    expect(create.mock.calls[0][1].signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("races caller abort even for an uncooperative provider and cleans listeners", async () => {
    vi.useFakeTimers(); const { create, verifier } = setup(); const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener"), remove = vi.spyOn(controller.signal, "removeEventListener");
    create.mockImplementation(() => new Promise(() => {})); const pending = verifier.evaluate({ ...input(), signal: controller.signal });
    controller.abort("private-abort"); expect(await pending).toMatchObject({ reason: "aborted" });
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]); expect(vi.getTimerCount()).toBe(0);
  });
  it("checks deadline immediately after await before accepting a verdict", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); const { create, verifier } = setup();
    create.mockImplementation(async () => { vi.setSystemTime(2000); return response(); });
    expect(await verifier.evaluate(input())).toMatchObject({ reason: "deadline_exceeded", evaluated: false, responseStatus: "completed" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([false, true])("cleans timers/listeners after settled provider (reject=%s) without retry", async (reject) => {
    vi.useFakeTimers(); const { create, verifier } = setup(); const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener"), remove = vi.spyOn(controller.signal, "removeEventListener");
    if (reject) create.mockRejectedValue(new Error("private-provider-error"));
    const result = await verifier.evaluate({ ...input(), signal: controller.signal });
    expect(result).toMatchObject({ reason: reject ? "provider_error" : "verified" });
    if (reject) expect(result).not.toHaveProperty("responseStatus");
    expect(create).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]); expect(vi.getTimerCount()).toBe(0);
  });
  it("withholds invalid input before any call", async () => {
    const { create, verifier } = setup(); expect(await verifier.evaluate({ ...input(), candidate: "" })).toMatchObject({ reason: "empty_candidate", evaluated: false });
    expect(create).not.toHaveBeenCalled();
  });
  it("bounds full serialized request including escaping and schema overhead", async () => {
    const { create, verifier } = setup();
    const args = { ...input(), question: "", candidate: "\\".repeat(32768) };
    expect(buildEvaluationVerifierInput(args).status).toBe("invalid");
    // Find largest candidate admitted by Task 2; SDK envelope must reject it.
    let low = 1, high = 32768;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (buildEvaluationVerifierInput({ ...args, candidate: "\\".repeat(mid) }).status === "ready") low = mid; else high = mid - 1; }
    const bounded = { ...args, candidate: "\\".repeat(low) };
    expect(buildEvaluationVerifierInput(bounded).status).toBe("ready");
    expect(await verifier.evaluate(bounded)).toMatchObject({ reason: "limit_exceeded", attemptCount: 0 }); expect(create).not.toHaveBeenCalled();
  });
  it("ignores actual optional thought and user_input metadata without retaining it", async () => {
    const steps: Interactions.Step[] = [{ type: "thought" }, { type: "user_input" },
      { type: "thought", signature: "private-signature", summary: [{ type: "text", text: "private-thought" }] },
      { type: "user_input", content: [{ type: "text", text: "private-input" }] }, output()];
    const { verifier } = setup(response({ steps })); const result = await verifier.evaluate(input());
    expect(result.reason).toBe("verified"); expect(JSON.stringify(result)).not.toMatch(/private|thought|signature|content/);
  });
  it("admits exactly 128 KiB of full request JSON and withholds the next byte", async () => {
    const { create, verifier } = setup(); await verifier.evaluate(input());
    const template = create.mock.calls[0][0]; create.mockClear();
    const requestBytes = (candidate: string, question = "") => {
      const prepared = buildEvaluationVerifierInput({ ...input(), question, candidate });
      if (prepared.status !== "ready") return Infinity;
      return Buffer.byteLength(JSON.stringify({ ...template, input: prepared.prompt, system_instruction: prepared.systemInstruction }));
    };
    let low = 1, high = 16000;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (requestBytes("\\".repeat(mid)) <= 131072) low = mid; else high = mid - 1; }
    const candidate = "\\".repeat(low), question = "x".repeat(131072 - requestBytes(candidate));
    expect(requestBytes(candidate, question)).toBe(131072);
    expect(await verifier.evaluate({ ...input(), question, candidate })).toMatchObject({ reason: "verified", attemptCount: 1 });
    expect(Buffer.byteLength(JSON.stringify(create.mock.calls[0][0]))).toBe(131072); create.mockClear();
    expect(await verifier.evaluate({ ...input(), question: question + "x", candidate })).toMatchObject({ reason: "limit_exceeded", attemptCount: 0 });
    expect(create).not.toHaveBeenCalled();
  });
  it("checks deadline after response validation work and ignores SDK convenience text", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); const value = response({ output_text: "private-not-a-verdict" });
    Object.defineProperty(value, "usage", { get: () => { vi.setSystemTime(2000); return undefined; } });
    expect(await setup(value).verifier.evaluate(input())).toMatchObject({ reason: "deadline_exceeded", evaluated: false });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("consumes late provider rejection after deadline without reopening or retrying", async () => {
    vi.useFakeTimers(); const { create, verifier } = setup(); let reject!: (error: Error) => void;
    create.mockImplementation(() => new Promise((_resolve, onReject) => { reject = onReject; }));
    const pending = verifier.evaluate(input()); await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ reason: "deadline_exceeded", attemptCount: 1 });
    reject(new Error("private-late-error")); await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["in_progress", "requires_action", "failed", "cancelled", "incomplete", "budget_exceeded", "queued"])("preserves arrived status %s while still withholding", async (status) => {
    expect(await setup(response({ status })).verifier.evaluate(input())).toMatchObject({ reason: "incomplete_response", evaluated: false, responseStatus: status });
  });
  it.each([undefined, "PRIVATE future status", "missing", "unknown", 7, null, { secret: "PRIVATE" }])("maps absent or unrecognized status to a safe sentinel (%#)", async status => {
    const result = await setup({ ...response(), status }).verifier.evaluate(input());
    expect(result).toMatchObject({ reason: "incomplete_response", evaluated: false,
      responseStatus: status === undefined ? "missing" : "unknown" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("normalizes primitive status without copying or coercing unknown values", () => {
    expect(normalizeEvaluationResponseStatus(undefined)).toBe("missing");
    expect(normalizeEvaluationResponseStatus("completed")).toBe("completed");
    for (const status of ["missing", "unknown", "PRIVATE", null, 1, { toString: () => { throw new Error("must not coerce"); } }]) {
      expect(normalizeEvaluationResponseStatus(status)).toBe("unknown");
    }
  });
  it("snapshots the response status once and uses the same value for validation", async () => {
    const status = vi.fn().mockReturnValueOnce("completed").mockReturnValue("PRIVATE changed status");
    const value = response(); Object.defineProperty(value, "status", { get: status });
    const result = await setup(value).verifier.evaluate(input());
    expect(result).toMatchObject({ reason: "verified", responseStatus: "completed" });
    expect(status).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("preserves status on an arrived fault without retaining error or finish details", async () => {
    const result = await setup({ ...response({ status: "failed", errors: [{ code: "PRIVATE error URI", message: "PRIVATE error" }] }),
      finish_reason: "PRIVATE finish", output_text: "PRIVATE output" }).verifier.evaluate(input());
    expect(result).toMatchObject({ reason: "provider_error", evaluated: false, responseStatus: "failed" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it.each([
    { steps: [] }, { steps: undefined }, { steps: [output(), output()] },
    { steps: [{ type: "model_output", content: [{ type: "text", text: verdict }, { type: "text", text: verdict }] }] },
    { steps: [{ type: "model_output", content: [{ type: "image", data: "private" }] }] },
    { steps: [{ type: "model_output" }] }, { steps: [{ type: "unknown" }] },
    { steps: [{ type: "thought", summary: "private" }, output()] },
    { steps: [{ type: "user_input", content: "private" }, output()] },
  ])("withholds malformed/competing response %#", async (overrides) => {
    expect(await setup({ ...response(), ...overrides }).verifier.evaluate(input())).toMatchObject({ reason: "invalid_response", evaluated: false });
  });
  it.each(["code_execution_call", "code_execution_result", "file_search_call", "file_search_result", "function_call", "function_result", "google_maps_call", "google_maps_result", "google_search_call", "google_search_result", "mcp_server_tool_call", "mcp_server_tool_result", "processing_call", "processing_result", "url_context_call", "url_context_result"])("withholds forbidden step %s", async (type) => {
    expect(await setup({ ...response(), steps: [{ type }, output()] }).verifier.evaluate(input())).toMatchObject({ reason: "invalid_response", evaluated: false });
  });
  it.each([{ errors: [{ message: "private-error" }] }, { steps: [{ ...output(), error: { code: 1, message: "private-error" } }] }])("withholds provider/step faults %#", async (overrides) => {
    expect(await setup({ ...response(), ...overrides }).verifier.evaluate(input())).toMatchObject({ reason: "provider_error", evaluated: false });
  });
  it("bounds steps and visible JSON bytes without truncation", async () => {
    expect((await setup(response({ steps: [...Array.from({ length: 127 }, (): Interactions.Step => ({ type: "thought" })), output()] })).verifier.evaluate(input())).reason).toBe("verified");
    expect((await setup(response({ steps: [...Array.from({ length: 128 }, (): Interactions.Step => ({ type: "thought" })), output()] })).verifier.evaluate(input())).reason).toBe("limit_exceeded");
    const exact = verdict + " ".repeat(EVALUATION_LIMITS.maxResponseJsonBytes - Buffer.byteLength(verdict));
    expect((await setup(response({ steps: [output(exact)] })).verifier.evaluate(input())).reason).toBe("verified");
    expect((await setup(response({ steps: [output(exact + " ")] })).verifier.evaluate(input())).reason).toBe("limit_exceeded");
  });
  it("delegates malformed, duplicate-key and whole-candidate checks to Task 2", async () => {
    for (const text of ["private-bad-json", verdict.replace('"pass"', '"withhold","decision":"pass"')]) {
      expect(await setup(response({ steps: [output(text)] })).verifier.evaluate(input())).toMatchObject({ reason: "invalid_verdict", evaluated: false });
    }
    expect(await setup().verifier.evaluate({ ...input(), candidate: "First gap.\n\nSecond gap." })).toMatchObject({ reason: "missing_segment", evaluated: false });
    const unsupported = verdict.replace('"pass"', '"withhold"').replace('"evidence_gap"', '"contradicted"');
    expect(await setup(response({ steps: [output(unsupported)] })).verifier.evaluate(input())).toMatchObject({ decision: "withhold", reason: "unsupported_claim", evaluated: true });
  });
  it("preserves optional raw usage separately on rejected outputs without billing arithmetic", async () => {
    const usage = { total_input_tokens: 11, total_output_tokens: 7, total_thought_tokens: 3, total_cached_tokens: 2, total_tokens: 21, total_tool_use_tokens: 0 };
    const result = await setup(response({ status: "failed", usage })).verifier.evaluate(input());
    expect(result).toMatchObject({ reason: "incomplete_response", usage }); expect(Object.isFrozen(result.usage)).toBe(true);
    expect((await setup(response({ usage: { total_input_tokens: 0 } })).verifier.evaluate(input())).usage).toEqual({ total_input_tokens: 0 });
    expect((await setup().verifier.evaluate(input())).usage).toBeUndefined();
  });
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "7", null])("drops invalid usage instead of fabricating counters (%s)", async (count) => {
    const result = await setup({ ...response(), usage: { total_input_tokens: 10, total_thought_tokens: count } }).verifier.evaluate(input());
    expect(result.reason).toBe("verified"); expect(result.usage).toBeUndefined();
  });
});
