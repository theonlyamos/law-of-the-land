// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { caseInput } from "../test-fixtures/reviewed-request-catalog";
import { authoredStage, FAKE_CREDENTIAL } from "../test-fixtures/reviewed-answer-fixtures";
import { buildStageRequest, prepareSplitInput, validateInventory, type StageRequest } from "./contracts";
import { GOOGLE_PROVIDER_SETTINGS } from "./google-provider-settings";
import { createStreamingStageExecutor } from "./streaming";

const usage = { total_input_tokens: 10, total_output_tokens: 20, total_thought_tokens: 30, total_cached_tokens: 0, total_tool_use_tokens: 0, total_tokens: 60 };
function streamResponse(request: StageRequest, json = JSON.stringify(authoredStage(request))) {
  const events = [
    { event_type: "interaction.created", interaction: { model: "gemini-3.8-flash", object: "interaction" } },
    { event_type: "step.start", index: 3, step: { type: "model_output", content: [] } },
    { event_type: "step.delta", index: 3, delta: { type: "text", text: json } },
    { event_type: "step.stop", index: 3 },
    { event_type: "interaction.completed", interaction: { status: "completed", usage } },
  ];
  return new Response(Buffer.from(events.map(event => `event: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`).join("")), { headers: { "content-type": "text/event-stream" } });
}
function fixture() {
  let wall = 100_000, mono = 1_000;
  const prepared = prepareSplitInput(caseInput("nine-month-control"))!;
  const request = buildStageRequest(prepared, "inventory", "authored-background-stream", 340_000, undefined, "inventory_low")!;
  const inventory = validateInventory(JSON.stringify(authoredStage(request)), prepared)!;
  const delays: number[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init!.body)), data = JSON.parse(wire.input);
    const stage = /Fixed stage: (inventory|consent|overtime)\./.exec(wire.system_instruction)![1];
    return streamResponse({ stage, data } as StageRequest);
  });
  const configuration = { prepared, credential: FAKE_CREDENTIAL, fetch, entered: { wall: 100_000, mono: 1_000 },
    clock: { wall: () => wall, monotonic: () => mono }, thinkingPolicy: "inventory_low" as const,
    timer: (_callback: () => void, milliseconds: number) => { delays.push(milliseconds); return 1; }, clearTimer: (_handle: unknown) => {} };
  return { request, inventory, fetch, configuration, delays, setClock(w: number, m: number) { wall = w; mono = m; } };
}
const signal = () => new AbortController().signal;

describe("background streaming timing policy", () => {
  it("dispatches after 85 seconds with the original 240-second cap and pinned Google settings", async () => {
    const f = fixture(); f.setClock(190_000, 91_000);
    const execute = createStreamingStageExecutor({ ...f.configuration, timingPolicy: "background" });
    await expect(execute(f.request, signal())).resolves.toMatchObject({ status: "completed", binding: f.request.binding });
    expect(f.delays).toEqual([150_000]); expect(f.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = f.fetch.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(init!.body))).toMatchObject({ model: "gemini-3.8-flash", stream: true, store: false, tools: [],
      generation_config: { max_output_tokens: 8192, thinking_level: "low" } });
    expect(GOOGLE_PROVIDER_SETTINGS).toMatchObject({ maxOutputTokens: 8192, maxRawResponseBytes: 2_097_152, maxModelJsonBytes: 65_536, deadlineMs: 85_000 });
  });
  it("uses one original deadline for late inventory and both audits", async () => {
    const f = fixture(), execute = createStreamingStageExecutor({ ...f.configuration, timingPolicy: "background" });
    f.setClock(220_000, 121_000); await execute(f.request, signal());
    f.setClock(339_999, 240_999);
    const audits = (["consent", "overtime"] as const).map(stage => buildStageRequest(f.configuration.prepared, stage,
      f.request.binding.requestId, 340_000, f.inventory, "inventory_low")!);
    await Promise.all(audits.map(request => execute(request, signal())));
    expect(f.delays).toEqual([120_000, 1, 1]); expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.fetch.mock.calls.map(([_url, init]) => JSON.parse(String(init!.body)).generation_config.thinking_level)).toEqual(["low", "medium", "medium"]);
  });
  it.each([undefined, "standard"] as const)("keeps standard transport at 85 seconds for policy %s", async timingPolicy => {
    const f = fixture(); f.setClock(185_000, 86_000);
    await expect(createStreamingStageExecutor({ ...f.configuration, timingPolicy })(f.request, signal())).rejects.toMatchObject({ code: "ORIGINAL_DEADLINE" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([240_000, 240_001])("refuses dispatch at background elapsed %i", async elapsed => {
    const f = fixture(); f.setClock(100_000 + elapsed, 1_000 + elapsed);
    await expect(createStreamingStageExecutor({ ...f.configuration, timingPolicy: "background" })(f.request, signal())).rejects.toMatchObject({ code: "ORIGINAL_DEADLINE" });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.delays).toEqual([]);
  });
  it("checks expiry again after a completion diagnostic consumes the remaining background time", async () => {
    const f = fixture(); f.setClock(190_000, 91_000);
    const execute = createStreamingStageExecutor({ ...f.configuration, timingPolicy: "background",
      onDiagnostic: diagnostic => { if (diagnostic.phase === "completed") f.setClock(340_000, 241_000); } });
    await expect(execute(f.request, signal())).rejects.toMatchObject({ code: "ORIGINAL_DEADLINE" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("preserves an earlier caller cutoff against monotonic elapsed time during wall rollback", async () => {
    const f = fixture(), request = { ...f.request, deadlineAt: 220_000 };
    const execute = createStreamingStageExecutor({ ...f.configuration, timingPolicy: "background" });
    f.setClock(99_000, 121_000);
    await expect(execute(request, signal())).rejects.toMatchObject({ code: "ORIGINAL_DEADLINE" }); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("does not dispatch a background request with an already aborted caller", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort(); f.setClock(190_000, 91_000);
    await expect(createStreamingStageExecutor({ ...f.configuration, timingPolicy: "background" })(f.request, controller.signal))
      .rejects.toMatchObject({ code: "CALLER_ABORTED" }); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("aborts an uncooperative header wait after dispatch past 85 seconds without retrying", async () => {
    const f = fixture(), controller = new AbortController(); f.setClock(190_000, 91_000);
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    f.fetch.mockImplementation(() => { entered(); return new Promise<Response>(() => {}); });
    const pending = createStreamingStageExecutor({ ...f.configuration, timingPolicy: "background" })(f.request, controller.signal);
    await Promise.race([started, pending]); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CALLER_ABORTED" });
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });
  it.each([null, "unknown", false, 240_000])("rejects invalid trusted transport timing policy %j before fetch", timingPolicy => {
    const f = fixture(); expect(() => createStreamingStageExecutor({ ...f.configuration, timingPolicy } as never)).toThrow("TIMING_POLICY_INVALID");
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("captures the transport timing policy before configuration mutation", async () => {
    const f = fixture(), configuration = { ...f.configuration, timingPolicy: "background" as "standard" | "background" };
    const execute = createStreamingStageExecutor(configuration); configuration.timingPolicy = "standard"; f.setClock(190_000, 91_000);
    await expect(execute(f.request, signal())).resolves.toMatchObject({ status: "completed" }); expect(f.delays).toEqual([150_000]);
  });
  it("reads a trusted transport timing policy accessor once", async () => {
    const f = fixture(); let reads = 0;
    const execute = createStreamingStageExecutor({ ...f.configuration, get timingPolicy() { return ++reads === 1 ? "background" as const : "standard" as const; } });
    f.setClock(190_000, 91_000); await expect(execute(f.request, signal())).resolves.toMatchObject({ status: "completed" }); expect(reads).toBe(1);
  });
  it("retains the model JSON output cap during the larger background window", async () => {
    const f = fixture(); f.setClock(190_000, 91_000);
    f.fetch.mockResolvedValue(streamResponse(f.request, JSON.stringify(authoredStage(f.request)) + " ".repeat(65_536)));
    await expect(createStreamingStageExecutor({ ...f.configuration, timingPolicy: "background" })(f.request, signal()))
      .rejects.toMatchObject({ code: "OUTPUT_BYTES_LIMIT" }); expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects a changed output-token cap before dispatch in background mode", async () => {
    const f = fixture(), execute = createStreamingStageExecutor({ ...f.configuration, timingPolicy: "background" });
    await expect(execute({ ...f.request, generation_config: { ...f.request.generation_config, max_output_tokens: 16_384 } } as never, signal()))
      .rejects.toMatchObject({ code: "STAGE_REQUEST_MISMATCH" }); expect(f.fetch).not.toHaveBeenCalled();
  });
});

it("expires an ignoring background header wait at the remaining original allowance and aborts fetch", async () => {
  const f = fixture(), caller = new AbortController(); f.setClock(190_000, 91_000);
  let timeout!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.fetch.mockImplementation(() => { entered(); return new Promise<Response>(() => {}); });
  const pending = createStreamingStageExecutor({ ...f.configuration, timingPolicy: "background",
    timer: (callback, milliseconds) => { timeout = callback; f.delays.push(milliseconds); return 1; } })(f.request, caller.signal);
  await Promise.race([started, pending]);
  const observedDelay = [...f.delays]; f.setClock(340_000, 241_000); timeout?.();
  await expect(pending).rejects.toMatchObject({ code: "ORIGINAL_DEADLINE" });
  expect(observedDelay).toEqual([150_000]); expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
});

it("keeps queue time consumed when a new-process background transport clock rolls backward", async () => {
  const f = fixture(); f.setClock(140_000, 1_000);
  const execute = createStreamingStageExecutor({ ...f.configuration, timingPolicy: "background",
    onDiagnostic: diagnostic => { if (diagnostic.phase === "completed") f.setClock(100_000, 201_000); } });
  await expect(execute(f.request, signal())).rejects.toMatchObject({ code: "ORIGINAL_DEADLINE" });
  expect(f.delays).toEqual([200_000]); expect(f.request.deadlineAt).toBe(340_000); expect(f.fetch).toHaveBeenCalledTimes(1);
});

it("rejects a background transport request deadline beyond the original 240-second cap before fetch", async () => {
  const f = fixture(), execute = createStreamingStageExecutor({ ...f.configuration, timingPolicy: "background" });
  await expect(execute({ ...f.request, deadlineAt: 340_001 }, signal())).rejects.toBeDefined();
  expect(f.fetch).not.toHaveBeenCalled();
});
