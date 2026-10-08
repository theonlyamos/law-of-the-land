import { STAGES, buildStageRequest, deepFreeze, prepareSplitInput, sha256, validateAudit, validateInventory,
  type Audit, type Inventory, type PreparedSplitInput, type SplitThinkingPolicy, type Stage, type StageRequest } from "./contracts";
import type { Clock, StageExecutor } from "./runner";
import { captureTrustedTimingPolicy, type TrustedTimingPolicy } from "../trusted-timing-policy";
import { assertNoCredential, GOOGLE_PROVIDER_SETTINGS, parseProviderResponse, serializeGoogleBody, strictJson } from "./google-wire";

export type StreamingIdentityBinding = Readonly<{ mode: "provider_id" | "stream_local_request_binding"; providerInteractionIdObserved: boolean }>;
export type StreamingStageDiagnostic = Readonly<{ stage: Stage; phase: "event" | "completed" | "failed"; eventOrdinal: number;
  eventType?: string; status?: string; reason?: string; identityBinding?: StreamingIdentityBinding;
  usage?: Readonly<{ input: number; output: number; thought: number }> }>;
export type StreamingStageConfiguration = Readonly<{ prepared: PreparedSplitInput; credential: string; fetch: typeof fetch;
  entered: Readonly<{ wall: number; mono: number }>; clock?: Clock; timer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (handle: unknown) => void; onDiagnostic?: (diagnostic: StreamingStageDiagnostic) => void; thinkingPolicy?: SplitThinkingPolicy;
  timingPolicy?: TrustedTimingPolicy }>;

type JsonObject = Record<string, unknown>;
type Decoded = ReturnType<typeof parseProviderResponse> & { verdict: Inventory | Audit; raw: Buffer; envelope: JsonObject; identityBinding: StreamingIdentityBinding };
type Step = { type: "thought"; signature?: string; summary?: []; stopped: boolean } | { type: "model_output"; text: string; stopped: boolean };
type Frame = { data: string[]; event?: string; id?: string };
const LIMIT = { raw: 2097152, json: 65536, steps: 128, events: 4096, frame: 262144, line: 262144 } as const;
const EVENT_TYPES = ["interaction.created", "interaction.status_update", "interaction.completed", "step.start", "step.delta", "step.stop", "error"];
const STATUSES = ["in_progress", "queued", "requires_action", "completed", "failed", "cancelled", "incomplete"];
const failures = new WeakMap<object, string>(), failureToken = {};
class StreamingFailure extends Error {
  readonly code!: string;
  constructor(code: string, token: object) {
    super(token === failureToken ? code : "STREAM_TRANSPORT_FAILED");
    Object.defineProperty(this, "code", { value: token === failureToken ? code : "STREAM_TRANSPORT_FAILED", enumerable: true });
    if (token === failureToken) failures.set(this, code);
  }
}
const failure = (code: string) => new StreamingFailure(code, failureToken);
const fail = (code: string): never => { throw failure(code); };
function need(condition: unknown, code: string): asserts condition { if (!condition) fail(code); }
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: JsonObject, key: string) => Object.hasOwn(value, key);
function fields(value: unknown, allowed: readonly string[], code: string): JsonObject {
  need(object(value) && Object.keys(value).every(key => allowed.includes(key)), code); return value;
}
function checked<T>(operation: () => T, code: string): T {
  try { return operation(); } catch (error) { if (object(error) && failures.has(error)) throw error; return fail(code); }
}
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => same(item, right[index]));
  return object(left) && object(right) && Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => own(right, key) && same(left[key], right[key]));
}
function metadata(value: JsonObject, allowAbsentId = false): string | undefined {
  let id: string | undefined;
  if (!allowAbsentId || own(value, "id")) {
    need(typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256, "INTERACTION_ID_INVALID"); id = value.id;
  }
  if (own(value, "object")) need(value.object === "interaction", "INTERACTION_OBJECT_INVALID");
  for (const field of ["created", "updated"] as const) if (own(value, field)) {
    const timestamp = value[field]; need(typeof timestamp === "string" && timestamp.length <= 128 || typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp >= 0,
      field === "created" ? "INTERACTION_CREATED_INVALID" : "INTERACTION_UPDATED_INVALID");
  }
  if (own(value, "service_tier")) need(typeof value.service_tier === "string" && value.service_tier.length <= 64, "INTERACTION_SERVICE_TIER_INVALID");
  if (own(value, "errors")) need(Array.isArray(value.errors) && value.errors.length === 0, "INTERACTION_ERRORS_PRESENT");
  return id;
}
function lifecycle(value: unknown, allowed: readonly string[], code: string): JsonObject {
  if (object(value)) { need(!own(value, "agent"), "LIFECYCLE_AGENT_UNSUPPORTED"); need(!own(value, "continuation_token"), "LIFECYCLE_CONTINUATION_UNSUPPORTED"); }
  return fields(value, allowed, code);
}
function partialUsage(value: unknown) {
  const scalars = ["total_cached_tokens", "total_input_tokens", "total_output_tokens", "total_thought_tokens", "total_tokens", "total_tool_use_tokens"];
  const arrays = ["cached_tokens_by_modality", "input_tokens_by_modality", "output_tokens_by_modality", "tool_use_tokens_by_modality", "grounding_tool_count"];
  const usage = fields(value, [...scalars, ...arrays], "PARTIAL_USAGE_FIELDS");
  for (const field of scalars) if (own(usage, field)) need(typeof usage[field] === "number" && Number.isSafeInteger(usage[field]) && usage[field] >= 0, "PARTIAL_USAGE_COUNTER");
  for (const field of arrays) if (own(usage, field)) {
    const rows = usage[field]; need(Array.isArray(rows) && rows.length <= 16, "PARTIAL_USAGE_ARRAY");
    const name = field === "grounding_tool_count" ? "type" : "modality", number = field === "grounding_tool_count" ? "count" : "tokens";
    for (const item of rows) {
      const row = fields(item, [name, number], "PARTIAL_USAGE_ROW_FIELDS");
      if (own(row, name)) need(typeof row[name] === "string" && row[name].length > 0 && row[name].length <= 32, "PARTIAL_USAGE_ROW_NAME");
      if (own(row, number)) need(typeof row[number] === "number" && Number.isSafeInteger(row[number]) && row[number] >= 0, "PARTIAL_USAGE_ROW_COUNTER");
    }
  }
}
function createDecoder(request: StageRequest, prepared: PreparedSplitInput, inventory: Inventory | undefined,
  emit: (value: Omit<StreamingStageDiagnostic, "stage">) => void) {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }), raw: Uint8Array[] = [], steps = new Map<number, Step>(), ids = new Set<string>();
  let rawBytes = 0, eventCount = 0, eventOrdinal = 0, modelOutputs = 0, outputBytes = 0;
  let created: JsonObject | undefined, terminal: JsonObject | undefined, boundInteractionId: string | undefined;
  let sparseCreation = false, done = false, finished = false, line = "", lineBytes = 0, frameBytes = 0, pendingCR = false, firstCharacter = true;
  let frame: Frame = { data: [] };
  function identity(frameId: string | undefined, eventId: unknown) {
    if (eventId !== undefined) need(typeof eventId === "string", "EVENT_ID_TYPE");
    if (frameId !== undefined && eventId !== undefined) need(frameId === eventId, "EVENT_ID_MISMATCH");
    const id = eventId ?? frameId;
    if (id !== undefined) { need(typeof id === "string" && !id.includes("\0"), "EVENT_ID_INVALID"); need(!ids.has(id), "EVENT_ID_DUPLICATE"); ids.add(id); }
  }
  function assembledSteps() { return [...steps.values()].map(step => step.type === "thought"
    ? { type: "thought", ...(step.signature === undefined ? {} : { signature: step.signature }), ...(step.summary === undefined ? {} : { summary: [] }) }
    : { type: "model_output", content: [{ type: "text", text: step.text }] }); }
  function event(rawValue: unknown) {
    const value = object(rawValue) ? rawValue : {};
    eventOrdinal++;
    const status = object(value.interaction) && own(value.interaction, "status") ? value.interaction.status : value.status;
    emit({ phase: "event", eventOrdinal, eventType: typeof value.event_type === "string" && EVENT_TYPES.includes(value.event_type) ? value.event_type : "unknown",
      status: status === undefined ? "missing" : typeof status === "string" && STATUSES.includes(status) ? status : "unknown" });
    need(object(rawValue) && typeof value.event_type === "string", "EVENT_TYPE_INVALID");
    if (frame.event !== undefined) need(frame.event === value.event_type, "EVENT_NAME_MISMATCH");
    identity(frame.id, value.event_id); need(EVENT_TYPES.includes(value.event_type), "EVENT_TYPE_UNSUPPORTED");
    if (value.event_type === "error") fail("PROVIDER_ERROR_EVENT");
    need(!terminal && !done, "EVENT_AFTER_TERMINAL");
    const common = ["event_type", "event_id"], type = value.event_type;
    if (type === "interaction.created") {
      fields(value, [...common, "interaction"], "CREATED_EVENT_FIELDS"); need(!created, "CREATED_DUPLICATE");
      const interaction = lifecycle(value.interaction, ["id", "model", "status", "object", "created", "updated", "service_tier", "errors", "steps", "usage"], "CREATED_INTERACTION_FIELDS");
      const provisional = !own(interaction, "id") && !own(interaction, "status");
      if (provisional) need(Object.keys(interaction).length === 2 && own(interaction, "model") && own(interaction, "object"), "SPARSE_CREATION_FIELDS");
      const id = metadata(interaction, provisional);
      need(!own(interaction, "status") || interaction.status === "in_progress", "CREATED_STATUS");
      need(!own(interaction, "model") || interaction.model === GOOGLE_PROVIDER_SETTINGS.model, "CREATED_MODEL_MISMATCH");
      if (own(interaction, "steps")) need(Array.isArray(interaction.steps) && interaction.steps.length === 0, "CREATED_STEPS_UNSUPPORTED");
      if (own(interaction, "usage")) partialUsage(interaction.usage);
      created = interaction; sparseCreation = provisional; if (!provisional) boundInteractionId = id; return;
    }
    need(created, "EXPECTED_CREATED");
    if (type === "interaction.status_update") {
      fields(value, [...common, "interaction_id", "status"], "STATUS_UPDATE_FIELDS");
      // Observed store:false progress is ID-free only while this exact sparse stream is still unbound.
      if (sparseCreation && boundInteractionId === undefined && !own(value, "interaction_id") && value.status === "in_progress"
        && Object.keys(value).length === 2 && own(value, "event_type") && own(value, "status")) return;
      need(typeof value.interaction_id === "string" && value.interaction_id.length > 0 && value.interaction_id.length <= 256, "STATUS_UPDATE_ID_INVALID");
      need(boundInteractionId === undefined || value.interaction_id === boundInteractionId, "STATUS_UPDATE_ID_MISMATCH");
      need(value.status === "in_progress" || value.status === "queued", "STATUS_UPDATE_STATUS");
      if (boundInteractionId === undefined) boundInteractionId = value.interaction_id; return;
    }
    if (type === "interaction.completed") {
      fields(value, [...common, "interaction"], "TERMINAL_EVENT_FIELDS");
      const interaction = lifecycle(value.interaction, ["id", "model", "status", "steps", "usage", "object", "created", "updated", "service_tier", "errors"], "TERMINAL_INTERACTION_FIELDS");
      const streamLocal = sparseCreation && boundInteractionId === undefined && !own(interaction, "id");
      const id = metadata(interaction, streamLocal);
      need(streamLocal || boundInteractionId === undefined || id === boundInteractionId, "TERMINAL_ID_MISMATCH"); need(interaction.status === "completed", "TERMINAL_STATUS");
      need(!own(interaction, "model") || interaction.model === GOOGLE_PROVIDER_SETTINGS.model, "TERMINAL_MODEL_MISMATCH");
      need(own(created, "model") || own(interaction, "model"), "PROVIDER_MODEL_UNOBSERVED");
      if (own(created, "created") && own(interaction, "created")) need(same(created.created, interaction.created), "TERMINAL_CREATED_MISMATCH");
      need(steps.size > 0 && modelOutputs === 1, "TERMINAL_OUTPUT_COUNT"); need([...steps.values()].every(step => step.stopped), "TERMINAL_OPEN_STEPS");
      const assembled = assembledSteps(); if (own(interaction, "steps")) need(same(interaction.steps, assembled), "TERMINAL_STEPS_MISMATCH");
      terminal = { ...interaction, ...(!own(interaction, "model") ? { model: created.model } : {}), ...(!own(interaction, "steps") ? { steps: assembled } : {}) };
      if (!streamLocal && boundInteractionId === undefined) boundInteractionId = id; return;
    }
    need(["step.start", "step.delta", "step.stop"].includes(type), "STEP_EVENT_TYPE");
    fields(value, [...common, "index", ...(type === "step.start" ? ["step"] : type === "step.delta" ? ["delta", "metadata"] : ["usage", "step_usage"])], "STEP_EVENT_FIELDS");
    need(typeof value.index === "number" && Number.isSafeInteger(value.index) && value.index >= 0, "STEP_INDEX_INVALID");
    if (type === "step.delta" && own(value, "metadata")) { const data = fields(value.metadata, ["total_usage"], "DELTA_METADATA_FIELDS"); if (own(data, "total_usage")) partialUsage(data.total_usage); }
    if (type === "step.stop") for (const field of ["usage", "step_usage"]) if (own(value, field)) partialUsage(value[field]);
    if (type === "step.start") {
      need(!steps.has(value.index), "STEP_START_DUPLICATE"); need(steps.size < LIMIT.steps, "STEP_COUNT_LIMIT");
      const step = fields(value.step, ["type", "signature", "summary", "content"], "STEP_START_FIELDS"); need(step.type === "thought" || step.type === "model_output", "STEP_TYPE_UNSUPPORTED");
      if (step.type === "thought") {
        need(!own(step, "content"), "THOUGHT_CONTENT_UNSUPPORTED"); need(!own(step, "signature") || typeof step.signature === "string", "THOUGHT_SIGNATURE_INVALID");
        need(!own(step, "summary") || Array.isArray(step.summary) && step.summary.length === 0, "THOUGHT_SUMMARY_UNSUPPORTED");
        steps.set(value.index, { type: "thought", ...(typeof step.signature === "string" ? { signature: step.signature } : {}), ...(own(step, "summary") ? { summary: [] } : {}), stopped: false });
      } else {
        need(!own(step, "signature") && !own(step, "summary"), "MODEL_OUTPUT_FIELDS"); need(modelOutputs === 0, "MODEL_OUTPUT_DUPLICATE"); let text = "";
        if (own(step, "content")) {
          need(Array.isArray(step.content) && step.content.length <= 1, "MODEL_CONTENT_COUNT");
          if (step.content.length) { const content = fields(step.content[0], ["type", "text"], "MODEL_CONTENT_FIELDS"); need(content.type === "text", "MODEL_CONTENT_TYPE"); need(typeof content.text === "string", "MODEL_CONTENT_TEXT"); text = content.text; }
        }
        outputBytes = Buffer.byteLength(text); need(outputBytes <= LIMIT.json, "INITIAL_OUTPUT_BYTES_LIMIT"); modelOutputs++; steps.set(value.index, { type: "model_output", text, stopped: false });
      }
      return;
    }
    const step = steps.get(value.index); need(step, "STEP_NOT_STARTED"); need(!step.stopped, "STEP_ALREADY_STOPPED");
    if (type === "step.stop") { step.stopped = true; return; }
    if (step.type === "thought") {
      const delta = fields(value.delta, ["type", "signature"], "THOUGHT_DELTA_FIELDS"); need(delta.type === "thought_signature", "THOUGHT_DELTA_TYPE");
      if (own(delta, "signature")) { need(typeof delta.signature === "string", "THOUGHT_DELTA_SIGNATURE_INVALID"); need(step.signature === undefined, "THOUGHT_SIGNATURE_DUPLICATE"); step.signature = delta.signature; }
    } else {
      const delta = fields(value.delta, ["type", "text"], "TEXT_DELTA_FIELDS"); need(delta.type === "text", "TEXT_DELTA_TYPE"); need(typeof delta.text === "string", "TEXT_DELTA_TEXT");
      outputBytes += Buffer.byteLength(delta.text); need(outputBytes <= LIMIT.json, "OUTPUT_BYTES_LIMIT"); step.text += delta.text;
    }
  }
  function dispatch() {
    if (frame.data.length) {
      need(++eventCount <= LIMIT.events, "EVENT_COUNT_LIMIT"); const data = frame.data.join("\n");
      if (data === "[DONE]") { need(terminal, "DONE_BEFORE_TERMINAL"); need(!done, "DONE_DUPLICATE"); need(frame.event === undefined || frame.event === "done", "DONE_EVENT_NAME"); identity(frame.id, undefined); done = true; }
      else event(checked(() => strictJson(data), "EVENT_JSON_INVALID"));
    }
    frame = { data: [] }; frameBytes = 0;
  }
  function endLine(width: number) {
    frameBytes += lineBytes + width; need(frameBytes <= LIMIT.frame, "FRAME_BYTES_LIMIT");
    if (line === "") dispatch();
    else if (!line.startsWith(":")) {
      const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon); let value = colon < 0 ? "" : line.slice(colon + 1); if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") frame.data.push(value);
      else if (field === "event" || field === "id") { need(!Object.hasOwn(frame, field), "FRAME_FIELD_DUPLICATE"); frame[field] = value; }
    }
    line = ""; lineBytes = 0;
  }
  function characters(text: string) {
    for (const char of text) {
      if (firstCharacter) { firstCharacter = false; if (char === "\uFEFF") { frameBytes += 3; continue; } }
      if (pendingCR) { pendingCR = false; endLine(char === "\n" ? 2 : 1); if (char === "\n") continue; }
      if (char === "\r") pendingCR = true;
      else if (char === "\n") endLine(1);
      else { line += char; lineBytes += Buffer.byteLength(char); need(lineBytes <= LIMIT.line, "LINE_BYTES_LIMIT"); need(frameBytes + lineBytes <= LIMIT.frame, "FRAME_BYTES_LIMIT"); }
    }
  }
  return {
    get eventOrdinal() { return eventOrdinal; },
    push(chunk: Uint8Array) {
      need(!finished, "DECODER_ALREADY_FINISHED"); need(chunk instanceof Uint8Array, "CHUNK_TYPE"); rawBytes += chunk.byteLength; need(rawBytes <= LIMIT.raw, "RAW_BYTES_LIMIT");
      const copy = Uint8Array.from(chunk); raw.push(copy); characters(checked(() => decoder.decode(copy, { stream: true }), "UTF8_DECODE"));
    },
    finish(): Decoded {
      need(!finished, "DECODER_ALREADY_FINISHED"); characters(checked(() => decoder.decode(), "UTF8_EOF")); if (pendingCR) { pendingCR = false; endLine(1); }
      need(!line.length && frameBytes === 0 && frame.data.length === 0, "EOF_PARTIAL_FRAME"); need(terminal, "EOF_MISSING_TERMINAL");
      const envelope = terminal, parsed = checked(() => parseProviderResponse(JSON.stringify(envelope)), "TERMINAL_ENVELOPE_INVALID");
      checked(() => strictJson(parsed.json), "MODEL_JSON_INVALID");
      const verdict = checked(() => request.stage === "inventory" ? validateInventory(parsed.json, prepared) : inventory && validateAudit(request.stage, parsed.json, prepared, inventory), "STAGE_VERDICT_INVALID");
      need(verdict, "STAGE_VERDICT_INVALID"); finished = true;
      return { ...parsed, verdict, raw: Buffer.concat(raw, rawBytes), envelope,
        identityBinding: Object.freeze({ mode: boundInteractionId === undefined ? "stream_local_request_binding" : "provider_id", providerInteractionIdObserved: boundInteractionId !== undefined }) };
    },
  };
}

type CapturedStreamingConfiguration = StreamingStageConfiguration & Readonly<{ verificationMs: number; originalMonotonicLimit: number }>;
async function executeStream(configuration: CapturedStreamingConfiguration, request: StageRequest, inventory: Inventory | undefined,
  sharedSignal: AbortSignal, signal: AbortSignal, emit: (value: Omit<StreamingStageDiagnostic, "stage">) => void): Promise<Decoded> {
  const clock = configuration.clock ?? { wall: Date.now, monotonic: () => performance.now() }, entered = configuration.entered;
  const timer = configuration.timer ?? ((callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds));
  const clear = configuration.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const duration = Math.min(configuration.verificationMs, request.deadlineAt - entered.wall), wallLimit = entered.wall + duration;
  const monoLimit = configuration.originalMonotonicLimit - (configuration.verificationMs - duration);
  const body = checked(() => JSON.parse(serializeGoogleBody(request, configuration.thinkingPolicy)) as JsonObject, "REQUEST_SERIALIZATION_INVALID");
  need(body.store === false && body.model === GOOGLE_PROVIDER_SETTINGS.model, "REQUEST_SETTINGS_INVALID"); body.stream = true;
  const serialized = JSON.stringify(body); checked(() => assertNoCredential(serialized, configuration.credential), "REQUEST_CREDENTIAL_ECHO");
  const decoder = createDecoder(request, configuration.prepared, inventory, emit), aborter = new AbortController();
  let reason: string | undefined, handle: unknown, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, response: Response | undefined, successful = false, closed = false;
  let rejectCancellation!: (error: StreamingFailure) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; }); void cancellation.catch(() => {});
  function cancel(code: string) { if (!reason) { reason = code; aborter.abort(); rejectCancellation(failure(code)); } }
  function check() {
    if (signal.aborted) cancel("CALLER_ABORTED"); if (sharedSignal.aborted) cancel("ADAPTER_HALTED");
    const now = clock.wall(), mono = clock.monotonic();
    if (!Number.isFinite(now) || !Number.isFinite(mono) || mono < entered.mono || now >= wallLimit || mono >= monoLimit) cancel("ORIGINAL_DEADLINE");
    if (reason) fail(reason);
  }
  const onAbort = () => cancel("CALLER_ABORTED"), onSharedAbort = () => cancel("ADAPTER_HALTED");
  function cancelQuietly(target: { cancel(): Promise<unknown> } | null | undefined) { try { if (target) void Promise.resolve(target.cancel()).catch(() => {}); } catch { /* preserve the original rejection */ } }
  async function wait<T>(operation: () => Promise<T>): Promise<T> {
    check(); let value: T;
    try { value = await Promise.race([Promise.resolve().then(operation), cancellation]); }
    catch (error) { if (reason) fail(reason); if (object(error) && failures.has(error)) throw error; return fail("TRANSPORT_WAIT_FAILED"); }
    check(); return value;
  }
  try {
    check(); signal.addEventListener("abort", onAbort, { once: true }); sharedSignal.addEventListener("abort", onSharedAbort, { once: true }); check();
    handle = timer(() => cancel("ORIGINAL_DEADLINE"), Math.max(0, Math.min(wallLimit - clock.wall(), monoLimit - clock.monotonic())));
    response = await wait(() => {
      check(); const pending = Promise.resolve(configuration.fetch(GOOGLE_PROVIDER_SETTINGS.endpoint, { method: "POST", body: serialized, redirect: "error",
        headers: { "content-type": "application/json", "x-goog-api-key": configuration.credential }, signal: aborter.signal }));
      void pending.then(value => { response = value; if (closed || reason) cancelQuietly(value.body); }, () => {}); return pending;
    });
    need(response.status === 200, "HTTP_STATUS"); need(!response.redirected, "HTTP_REDIRECT");
    need(response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "text/event-stream", "HTTP_CONTENT_TYPE");
    need(response.body, "BODY_READER_MISSING"); reader = response.body.getReader();
    while (true) { const activeReader = reader; const part = await wait(() => activeReader.read()); if (part.done) break; decoder.push(part.value); check(); }
    const result = decoder.finish(); check(); checked(() => assertNoCredential(result.raw.toString("utf8"), configuration.credential), "RAW_CREDENTIAL_ECHO");
    checked(() => assertNoCredential(JSON.stringify(result.envelope), configuration.credential), "ASSEMBLED_CREDENTIAL_ECHO"); check(); successful = true; return result;
  } finally {
    closed = true; if (handle !== undefined) clear(handle); signal.removeEventListener("abort", onAbort); sharedSignal.removeEventListener("abort", onSharedAbort);
    if (!successful) { aborter.abort(); cancelQuietly(reader ?? response?.body); }
    try { reader?.releaseLock(); } catch { /* a late read remains observed by the race */ }
  }
}

export function createStreamingStageExecutor(configuration: StreamingStageConfiguration): StageExecutor {
  const { thinkingPolicy: suppliedThinkingPolicy, timingPolicy: suppliedTimingPolicy, entered: suppliedEntered, ...transportConfiguration } = configuration;
  const timing = captureTrustedTimingPolicy(suppliedTimingPolicy);
  need(timing, "TIMING_POLICY_INVALID");
  const thinkingPolicy = suppliedThinkingPolicy === undefined ? "medium" : suppliedThinkingPolicy;
  need(thinkingPolicy === "medium" || thinkingPolicy === "inventory_low", "THINKING_POLICY_INVALID");
  const prepared = prepareSplitInput(configuration.prepared.input);
  need(prepared && JSON.stringify(prepared) === JSON.stringify(configuration.prepared), "PREPARED_INPUT_MISMATCH");
  need(typeof configuration.credential === "string" && configuration.credential.length >= 12 && configuration.credential.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(configuration.credential), "CREDENTIAL_SHAPE_INVALID");
  need(typeof configuration.fetch === "function", "FETCH_SEAM_INVALID");
  const clock = configuration.clock ?? { wall: Date.now, monotonic: () => performance.now() };
  const entered = Object.freeze({ wall: suppliedEntered.wall, mono: suppliedEntered.mono });
  const admittedWall = clock.wall(), admittedMono = clock.monotonic();
  need(Number.isSafeInteger(entered.wall) && entered.wall >= 0 && Number.isFinite(entered.mono) && entered.mono >= 0
    && Number.isFinite(admittedWall) && Number.isFinite(admittedMono) && entered.wall <= admittedWall && entered.mono <= admittedMono, "ENTRY_ORIGIN_INVALID");
  // Queue elapsed time is consumed once, even when a worker restarts with a fresh process monotonic origin.
  const originalMonotonicLimit = admittedMono + Math.min(entered.wall + timing.verificationMs - admittedWall,
    timing.verificationMs - (admittedMono - entered.mono));
  const attempted = new Set<Stage>(), lifetime = new AbortController(); let requestId: string | undefined, acceptedInventory: Inventory | undefined, active = 0;
  return async (request, signal) => {
    let enteredStage = false, eventOrdinal = 0;
    const stage = STAGES.find(value => value === request.stage);
    const emit = (diagnostic: Omit<StreamingStageDiagnostic, "stage">) => {
      eventOrdinal = diagnostic.eventOrdinal;
      if (stage) try { configuration.onDiagnostic?.(deepFreeze({ stage, ...diagnostic })); } catch { /* diagnostics cannot change protocol acceptance */ }
    };
    try {
      need(!lifetime.signal.aborted, "ADAPTER_HALTED"); need(stage, "STAGE_REQUEST_INVALID"); need(!attempted.has(stage), "STAGE_ALREADY_ATTEMPTED"); need(active < 2, "CONCURRENCY_LIMIT");
      need(Number.isSafeInteger(request.deadlineAt) && (timing.verificationMs !== 240000 || request.deadlineAt - entered.wall <= timing.verificationMs)
        && typeof request.binding?.requestId === "string" && request.binding.requestId.length > 0 && request.binding.requestId.length <= 128, "STAGE_REQUEST_INVALID");
      need(requestId === undefined || requestId === request.binding.requestId, "REQUEST_ID_MISMATCH");
      const inventory = request.data.inventory === undefined ? undefined : validateInventory(JSON.stringify(request.data.inventory), prepared);
      if (stage !== "inventory") need(inventory && inventory.decision === "pass" && acceptedInventory && requestId === request.binding.requestId
        && sha256(JSON.stringify(inventory)) === sha256(JSON.stringify(acceptedInventory)), "INVENTORY_BINDING_INVALID");
      const expected = buildStageRequest(prepared, stage, request.binding.requestId, request.deadlineAt, inventory, thinkingPolicy);
      need(expected && JSON.stringify(expected) === JSON.stringify(request), "STAGE_REQUEST_MISMATCH");
      attempted.add(stage); requestId ??= request.binding.requestId; active++; enteredStage = true;
      const output = await executeStream({ ...transportConfiguration, prepared, clock, thinkingPolicy, entered, verificationMs: timing.verificationMs, originalMonotonicLimit }, request, inventory, lifetime.signal, signal, emit);
      emit({ phase: "completed", eventOrdinal, identityBinding: output.identityBinding, usage: output.usage });
      need(!signal.aborted, "CALLER_ABORTED"); need(!lifetime.signal.aborted, "ADAPTER_HALTED");
      const duration = Math.min(timing.verificationMs, request.deadlineAt - entered.wall), now = clock.wall(), mono = clock.monotonic();
      const monotonicLimit = originalMonotonicLimit - (timing.verificationMs - duration);
      need(Number.isFinite(now) && Number.isFinite(mono) && mono >= entered.mono && now < entered.wall + duration && mono < monotonicLimit, "ORIGINAL_DEADLINE");
      if (output.verdict.stage === "inventory" && output.verdict.decision === "pass") acceptedInventory = output.verdict;
      return Object.freeze({ binding: request.binding, status: "completed", json: output.json, usage: output.usage });
    } catch (error) {
      const code = object(error) ? failures.get(error) : undefined; const rejected = code ? error : failure("STREAM_TRANSPORT_FAILED");
      lifetime.abort(); emit({ phase: "failed", eventOrdinal, reason: code ?? "STREAM_TRANSPORT_FAILED" }); throw rejected;
    } finally { if (enteredStage) active--; }
  };
}
