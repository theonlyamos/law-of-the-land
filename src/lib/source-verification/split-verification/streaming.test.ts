// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { selectEmploymentEvidence } from "../employment-evidence";
import { buildStageRequest, prepareSplitInput, validateInventory, type StageRequest } from "./contracts";
import { createStreamingStageExecutor, type StreamingStageDiagnostic } from "./streaming";

type Event = { event_type: string; interaction?: Record<string, unknown>; index?: number; step?: Record<string, unknown>;
  delta?: Record<string, unknown>; [key: string]: unknown };
const credential = "AuthoredStreamingSecretZZ99";
const usage = { total_input_tokens: 10, total_output_tokens: 20, total_thought_tokens: 30, total_cached_tokens: 0, total_tool_use_tokens: 0, total_tokens: 60 };
function fixture() {
  const selected = selectEmploymentEvidence({ question: "Can my boss require overtime?", history: [], attachments: [] });
  if (selected.status !== "selected") throw new Error("missing fixture");
  const prepared = prepareSplitInput({ question: selected.question, facts: "Pregnancy unknown; no consent.", candidate: "Pregnancy remains unresolved.", evidence: selected.evidence })!;
  const inventory = { stage: "inventory", decision: "pass", segments: prepared.segments.map((segment, index) => ({ segmentId: segment.segmentId,
    claims: [{ claimId: `claim-${index}`, status: "supported", quote: segment.text, evidenceIds: [prepared.conditions[0].evidenceId] }] })) };
  const checked = validateInventory(JSON.stringify(inventory), prepared)!;
  const request = buildStageRequest(prepared, "inventory", "authored-stream-request", 85000)!;
  return { prepared, inventory, checked, request };
}
function stageJson(request: StageRequest) {
  if (request.stage === "inventory") return JSON.stringify(fixture().inventory);
  return JSON.stringify({ stage: request.stage, decision: "pass", partition: "accepted", claims: request.data.inventory!.segments.flatMap(segment => segment.claims.map(claim => ({
    claimId: claim.claimId, assessment: "not_applicable", scope: "none", ...(request.stage === "overtime" ? { conclusion: "none", alternatives: "not_applicable" } : {}),
  }))) });
}
function events(json = JSON.stringify(fixture().inventory)): Event[] { return [
  { event_type: "interaction.created", interaction: { model: "gemini-3.8-flash", object: "interaction" } },
  { event_type: "interaction.status_update", status: "in_progress" },
  { event_type: "step.start", index: 0, step: { type: "thought" } },
  { event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "authored-signature" } },
  { event_type: "step.stop", index: 0 },
  { event_type: "step.start", index: 3, step: { type: "model_output", content: [] } },
  { event_type: "step.delta", index: 3, delta: { type: "text", text: json } },
  { event_type: "step.stop", index: 3 },
  { event_type: "interaction.completed", interaction: { status: "completed", usage } },
]; }
const frame = (event: Event) => `event: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`;
const bytes = (rows: Event[]) => Buffer.from(rows.map(frame).join(""));
function harness(rows = events()) {
  const f = fixture(), diagnostics: StreamingStageDiagnostic[] = [], delays: number[] = [];
  let time = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(bytes(rows), { headers: { "content-type": "text/event-stream" } }));
  const configuration = { prepared: f.prepared, credential, fetch, entered: { wall: 0, mono: 0 }, clock: { wall: () => time, monotonic: () => time },
    timer: (_callback: () => void, milliseconds: number) => { delays.push(milliseconds); return 1; }, clearTimer: (_handle: unknown) => {},
    onDiagnostic: (diagnostic: StreamingStageDiagnostic) => { diagnostics.push(diagnostic); } };
  return { ...f, fetch, configuration, diagnostics, delays, setTime(value: number) { time = value; },
    create: () => createStreamingStageExecutor(configuration) };
}
function signal() { return new AbortController().signal; }
async function rejectRows(rows: Event[], reason: string) {
  const h = harness(rows); await expect(h.create()(h.request, signal())).rejects.toMatchObject({ code: reason });
  expect(h.fetch).toHaveBeenCalledTimes(1); expect(h.diagnostics.at(-1)).toMatchObject({ phase: "failed", reason });
  expect(JSON.stringify(h.diagnostics)).not.toContain(credential);
}

describe("streaming stage adapter", () => {
  it("accepts the exact sparse creation/progress stream and returns only the four trusted executor keys", async () => {
    const h = harness(), output = await h.create()(h.request, signal()) as Record<string, unknown>;
    expect(Object.keys(output).sort()).toEqual(["binding", "json", "status", "usage"]); expect(output.binding).toBe(h.request.binding);
    expect(output).toMatchObject({ status: "completed", json: JSON.stringify(h.inventory), usage: { input: 10, output: 20, thought: 30 } });
    expect(h.fetch).toHaveBeenCalledTimes(1); const [url, init] = h.fetch.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions"); expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(init!.body))).toMatchObject({ stream: true, store: false, tools: [], generation_config: { max_output_tokens: 8192, thinking_level: "medium" } });
    expect(h.diagnostics.at(-1)).toMatchObject({ phase: "completed", identityBinding: { mode: "stream_local_request_binding", providerInteractionIdObserved: false } });
  });
  it("binds a later authoritative provider ID without treating ID-free progress as completion", async () => {
    const e = events(); e.splice(2, 0, { event_type: "interaction.status_update", interaction_id: "provider-id", status: "in_progress" }); e.at(-1)!.interaction!.id = "provider-id";
    const h = harness(e); await h.create()(h.request, signal());
    expect(h.diagnostics.at(-1)).toMatchObject({ identityBinding: { mode: "provider_id", providerInteractionIdObserved: true } });
    expect(JSON.stringify(h.diagnostics)).not.toContain("provider-id");
  });
  it("keeps ordinary ID-bearing creation strict for missing status-update IDs", async () => {
    const e = events(); Object.assign(e[0].interaction!, { id: "provider-id", status: "in_progress" }); e.at(-1)!.interaction!.id = "provider-id";
    await rejectRows(e, "STATUS_UPDATE_ID_INVALID");
  });
  it("rejects ID-free progress after any authoritative ID has bound", async () => {
    const e = events(); e.splice(1, 0, { event_type: "interaction.status_update", interaction_id: "provider-id", status: "in_progress" });
    await rejectRows(e, "STATUS_UPDATE_ID_INVALID");
  });
  it.each([null, "", 123, false, [], {}, "x".repeat(257)].map(id => [id]))("rejects a malformed present status ID (%j)", async id => {
    const e = events(); e[1].interaction_id = id; await rejectRows(e, "STATUS_UPDATE_ID_INVALID");
  });
  it.each(["queued", "completed", "failed"])("rejects ID-free progress status %s", async status => {
    const e = events(); e[1].status = status; await rejectRows(e, "STATUS_UPDATE_ID_INVALID");
  });
  it("keeps the ID-free progress exception to the exact two-field payload", async () => {
    const e = events(); e[1].event_id = "resume-token"; await rejectRows(e, "STATUS_UPDATE_ID_INVALID");
  });
  it("rejects a non-string provider status even when its string coercion matches", async () => {
    const e = events(); e[1].interaction_id = "provider-id"; e[1].status = ["in_progress"]; e.at(-1)!.interaction!.id = "provider-id";
    await rejectRows(e, "STATUS_UPDATE_STATUS");
  });
  it("rejects a conflicting provider identity", async () => {
    const e = events(); e.splice(2, 0, { event_type: "interaction.status_update", interaction_id: "first", status: "in_progress" }); e.at(-1)!.interaction!.id = "second";
    await rejectRows(e, "TERMINAL_ID_MISMATCH");
  });
  it("cannot omit terminal identity once an authoritative ID appeared", async () => {
    const e = events(); e.splice(2, 0, { event_type: "interaction.status_update", interaction_id: "first", status: "in_progress" }); await rejectRows(e, "INTERACTION_ID_INVALID");
  });
  it.each([
    ["terminal status", (e: Event[]) => { delete e.at(-1)!.interaction!.status; }, "TERMINAL_STATUS"],
    ["terminal model", (e: Event[]) => { e.at(-1)!.interaction!.model = "other"; }, "TERMINAL_MODEL_MISMATCH"],
    ["terminal usage", (e: Event[]) => { delete e.at(-1)!.interaction!.usage; }, "TERMINAL_ENVELOPE_INVALID"],
    ["open output", (e: Event[]) => { e.splice(7, 1); }, "TERMINAL_OPEN_STEPS"],
    ["duplicate creation", (e: Event[]) => { e.splice(1, 0, e[0]); }, "CREATED_DUPLICATE"],
    ["tool step", (e: Event[]) => { e[2].step = { type: "function_call" }; }, "STEP_TYPE_UNSUPPORTED"],
    ["wrong stage JSON", (e: Event[]) => { e[6].delta!.text = '{"stage":"consent","decision":"pass"}'; }, "STAGE_VERDICT_INVALID"],
  ] as const)("withholds %s", async (_label, mutate, reason) => { const e = events(); mutate(e); await rejectRows(e, reason); });
  it("requires clean EOF despite parseable final JSON", async () => {
    const h = harness(), raw = bytes(events()); h.fetch.mockResolvedValue(new Response(raw.subarray(0, raw.length - 1), { headers: { "content-type": "text/event-stream" } }));
    await expect(h.create()(h.request, signal())).rejects.toMatchObject({ code: "EOF_PARTIAL_FRAME" });
  });
  it("preserves fragmented UTF8/CRLF and multiline SSE data", async () => {
    const h = harness(), raw = Buffer.from(': caf\u00e9\r\n\r\n' + events().map(e => `event: ${e.event_type}\r\n` + JSON.stringify(e, null, 2).split("\n").map(line => `data: ${line}`).join("\r\n") + "\r\n\r\n").join(""));
    h.fetch.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const byte of raw) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } }));
    await expect(h.create()(h.request, signal())).resolves.toMatchObject({ status: "completed" });
  });
  it("rejects duplicate JSON keys and invalid UTF8", async () => {
    for (const raw of [Buffer.from('data: {"event_type":"interaction.created","event_type":"interaction.created"}\n\n'), Buffer.from([0xc3, 0x28])]) {
      const h = harness(); h.fetch.mockResolvedValue(new Response(raw, { headers: { "content-type": "text/event-stream" } }));
      await expect(h.create()(h.request, signal())).rejects.toBeDefined(); expect(h.fetch).toHaveBeenCalledTimes(1);
    }
  });
  it("keeps the original wall and monotonic budget across delayed stage entry", async () => {
    const h = harness(); h.setTime(24000); await h.create()(h.request, signal()); expect(h.delays).toEqual([61000]);
  });
  it("cannot accept after the diagnostic callback consumes the original deadline", async () => {
    const h = harness(); h.configuration.onDiagnostic = diagnostic => { h.diagnostics.push(diagnostic); if (diagnostic.phase === "completed") h.setTime(85000); };
    await expect(h.create()(h.request, signal())).rejects.toMatchObject({ code: "ORIGINAL_DEADLINE" }); expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.diagnostics.at(-1)).toMatchObject({ phase: "failed", reason: "ORIGINAL_DEADLINE" });
  });
  it("does not dispatch after the original deadline or a pre-aborted signal", async () => {
    const h = harness(); h.setTime(85000); await expect(h.create()(h.request, signal())).rejects.toMatchObject({ code: "ORIGINAL_DEADLINE" }); expect(h.fetch).not.toHaveBeenCalled();
    const b = harness(), caller = new AbortController(); caller.abort(); await expect(b.create()(b.request, caller.signal)).rejects.toMatchObject({ code: "CALLER_ABORTED" }); expect(b.fetch).not.toHaveBeenCalled();
  });
  it("races cancellation while headers ignore abort and never retries", async () => {
    const h = harness(), caller = new AbortController(); let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
    h.fetch.mockImplementation(() => { started(); return new Promise<Response>(() => {}); });
    const pending = h.create()(h.request, caller.signal); await Promise.race([entered, pending]); caller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CALLER_ABORTED" }); expect(h.fetch).toHaveBeenCalledTimes(1); expect(h.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });
  it("cancels a pending body reader when the caller aborts", async () => {
    const h = harness(), caller = new AbortController(), cancel = vi.fn(); let entered!: () => void; const reading = new Promise<void>(resolve => { entered = resolve; });
    h.fetch.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ pull() { entered(); return new Promise<void>(() => {}); }, cancel }), { headers: { "content-type": "text/event-stream" } }));
    const pending = h.create()(h.request, caller.signal); await Promise.race([reading, pending]); caller.abort(); await expect(pending).rejects.toMatchObject({ code: "CALLER_ABORTED" }); expect(cancel).toHaveBeenCalled();
  });
  it("refuses duplicate attempts and audits that lack an actual passing inventory", async () => {
    const h = harness(), execute = h.create(); await execute(h.request, signal()); await expect(execute(h.request, signal())).rejects.toBeDefined(); expect(h.fetch).toHaveBeenCalledTimes(1);
    const other = harness(); const audit = buildStageRequest(other.prepared, "consent", "authored-stream-request", 85000, other.checked)!;
    await expect(other.create()(audit, signal())).rejects.toMatchObject({ code: "INVENTORY_BINDING_INVALID" }); expect(other.fetch).not.toHaveBeenCalled();
  });
  it("runs two audits only against the actual passing inventory and exact server binding", async () => {
    const h = harness(), execute = h.create(); h.fetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init!.body)) as { system_instruction: string };
      const stage = body.system_instruction.includes("Fixed stage: consent") ? "consent" : body.system_instruction.includes("Fixed stage: overtime") ? "overtime" : "inventory";
      const request = buildStageRequest(h.prepared, stage, h.request.binding.requestId, 85000, stage === "inventory" ? undefined : h.checked)!;
      return new Response(bytes(events(stageJson(request))), { headers: { "content-type": "text/event-stream" } });
    });
    await execute(h.request, signal());
    const requests = (["consent", "overtime"] as const).map(stage => buildStageRequest(h.prepared, stage, h.request.binding.requestId, 85000, h.checked)!);
    const outputs = await Promise.all(requests.map(request => execute(request, signal())));
    outputs.forEach((output, index) => expect((output as Record<string, unknown>).binding).toBe(requests[index].binding)); expect(h.fetch).toHaveBeenCalledTimes(3);
  });
  it("returns a valid inventory withhold for the runner to stop downstream audits", async () => {
    const f = fixture(), negative = { ...f.inventory, decision: "withhold", segments: f.inventory.segments.map(s => ({ ...s, claims: s.claims.map(c => ({ ...c, status: "insufficient_evidence" })) })) };
    const h = harness(events(JSON.stringify(negative))), execute = h.create(); await expect(execute(h.request, signal())).resolves.toMatchObject({ status: "completed" });
    await expect(execute(buildStageRequest(h.prepared, "consent", h.request.binding.requestId, 85000, h.checked)!, signal())).rejects.toMatchObject({ code: "INVENTORY_BINDING_INVALID" }); expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects request drift before dispatch", async () => {
    const h = harness(); await expect(h.create()({ ...h.request, systemInstruction: "changed" }, signal())).rejects.toMatchObject({ code: "STAGE_REQUEST_MISMATCH" }); expect(h.fetch).not.toHaveBeenCalled();
  });
  it("does not retain credentials in diagnostics, including echoes split across text deltas", async () => {
    const f = fixture(), model = structuredClone(f.inventory); model.segments[0].claims[0].claimId = credential;
    const e = events(); e.splice(6, 1, ...Array.from(JSON.stringify(model), text => ({ event_type: "step.delta", index: 3, delta: { type: "text", text } })));
    const h = harness(e); await expect(h.create()(h.request, signal())).rejects.toMatchObject({ code: "ASSEMBLED_CREDENTIAL_ECHO" }); expect(JSON.stringify(h.diagnostics)).not.toContain(credential);
  });
});

describe("inventory-only streaming policy", () => {
  it("sends low inventory and two medium audits with the actual frozen inventory and original bindings", async () => {
    const h = harness(), execute = createStreamingStageExecutor({ ...h.configuration, thinkingPolicy: "inventory_low" });
    h.fetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init!.body)) as { system_instruction: string };
      const stage = body.system_instruction.includes("Fixed stage: consent") ? "consent" : body.system_instruction.includes("Fixed stage: overtime") ? "overtime" : "inventory";
      const request = buildStageRequest(h.prepared, stage, h.request.binding.requestId, 85000, stage === "inventory" ? undefined : h.checked, "inventory_low")!;
      return new Response(bytes(events(stageJson(request))), { headers: { "content-type": "text/event-stream" } });
    });
    const inventory = buildStageRequest(h.prepared, "inventory", h.request.binding.requestId, 85000, undefined, "inventory_low")!;
    const first = await execute(inventory, signal()) as Record<string, unknown>;
    expect(first.binding).toBe(inventory.binding);
    const audits = (["consent", "overtime"] as const).map(stage => buildStageRequest(h.prepared, stage, h.request.binding.requestId, 85000, h.checked, "inventory_low")!);
    const results = await Promise.all(audits.map(request => execute(request, signal()))) as Record<string, unknown>[];
    results.forEach((result, index) => expect(result.binding).toBe(audits[index].binding));
    expect(h.fetch.mock.calls.map(([_url, init]) => JSON.parse(String(init!.body)).generation_config.thinking_level)).toEqual(["low", "medium", "medium"]);
    for (const [_url, init] of h.fetch.mock.calls) {
      expect(init).toMatchObject({ method: "POST", redirect: "error" });
      expect(JSON.parse(String(init!.body))).toMatchObject({ stream: true, store: false, tools: [], generation_config: { max_output_tokens: 8192 } });
    }
  });
  it("rejects policy mismatch before forwarding either inventory setting", async () => {
    const low = harness(), lowRequest = { ...low.request, generation_config: { ...low.request.generation_config, thinking_level: "low" } } as never;
    await expect(low.create()(lowRequest, signal())).rejects.toMatchObject({ code: "STAGE_REQUEST_MISMATCH" });
    expect(low.fetch).not.toHaveBeenCalled();
    const medium = harness(), candidate = createStreamingStageExecutor({ ...medium.configuration, thinkingPolicy: "inventory_low" });
    await expect(candidate(medium.request, signal())).rejects.toMatchObject({ code: "STAGE_REQUEST_MISMATCH" });
    expect(medium.fetch).not.toHaveBeenCalled();
  });
  it("rejects an unknown factory policy before any fetch", () => {
    const h = harness();
    expect(() => createStreamingStageExecutor({ ...h.configuration, thinkingPolicy: "globally_low" as never })).toThrow("THINKING_POLICY_INVALID");
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("captures the server factory policy once rather than following later configuration mutation", async () => {
    const h = harness(), configuration = { ...h.configuration, thinkingPolicy: "inventory_low" as "medium" | "inventory_low" };
    const execute = createStreamingStageExecutor(configuration);
    configuration.thinkingPolicy = "medium";
    const request = buildStageRequest(h.prepared, "inventory", h.request.binding.requestId, 85000, undefined, "inventory_low")!;
    await expect(execute(request, signal())).resolves.toMatchObject({ status: "completed" });
    expect(JSON.parse(String(h.fetch.mock.calls[0][1]!.body)).generation_config.thinking_level).toBe("low");
  });
  it.each(["consent", "overtime"] as const)("rejects a lowered %s audit after a valid low inventory before dispatching the audit", async stage => {
    const h = harness(), execute = createStreamingStageExecutor({ ...h.configuration, thinkingPolicy: "inventory_low" });
    await execute(buildStageRequest(h.prepared, "inventory", h.request.binding.requestId, 85000, undefined, "inventory_low")!, signal());
    const audit = buildStageRequest(h.prepared, stage, h.request.binding.requestId, 85000, h.checked, "inventory_low")!;
    await expect(execute({ ...audit, generation_config: { ...audit.generation_config, thinking_level: "low" } } as never, signal())).rejects.toMatchObject({ code: "STAGE_REQUEST_MISMATCH" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("single-read server policy capture", () => {
  it("reads a streaming policy accessor exactly once before any dispatch", async () => {
    const h = harness(); let reads = 0;
    const execute = createStreamingStageExecutor({ ...h.configuration, get thinkingPolicy() { return ++reads === 1 ? "inventory_low" as const : "medium" as const; } });
    const request = buildStageRequest(h.prepared, "inventory", h.request.binding.requestId, 85000, undefined, "inventory_low")!;
    await expect(execute(request, signal())).resolves.toMatchObject({ status: "completed" });
    expect(reads).toBe(1);
    expect(JSON.parse(String(h.fetch.mock.calls[0][1]!.body)).generation_config.thinking_level).toBe("low");
  });
});
