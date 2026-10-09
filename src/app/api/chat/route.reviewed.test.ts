// @vitest-environment node
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ isAuthenticated: vi.fn(), getToken: vi.fn(), fetchAuthMutation: vi.fn(), fetchAuthQuery: vi.fn(),
  create: vi.fn(), get: vi.fn(), loadChatAttachmentContext: vi.fn(), streamFactory: vi.fn(), stage: vi.fn() }));
vi.mock("@/lib/auth-server", () => mocks);
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit", () => ({ clientKey: () => "reviewed-test", rateLimit: () => ({ ok: true }) }));
vi.mock("@/lib/chat-attachment-server", async original => ({ ...await original<typeof import("@/lib/chat-attachment-server")>(), loadChatAttachmentContext: mocks.loadChatAttachmentContext }));
vi.mock("@google/genai", () => ({ GoogleGenAI: class { interactions = { create: mocks.create, get: mocks.get }; } }));
vi.mock("@/lib/source-verification/split-verification/streaming", () => ({ createStreamingStageExecutor: mocks.streamFactory }));
import { POST } from "./route";
import { PILOT_CATALOG, PILOT_IDENTITY } from "@/lib/source-verification/reviewed-source-cases";
import { GeminiFileSearchChat } from "@/lib/gemini-file-search-chat";
import type { StageRequest } from "@/lib/source-verification/split-verification/contracts";
const answer = "PRIVATE reviewed answer: café.\n\nExact second paragraph.";
const claim = "c".repeat(43);
const manifest = { authorizedScopeSize: 1, partialCoverage: false, stores: [{ jurisdictionId: PILOT_CATALOG.jurisdictionId,
  name: "Ghana", kind: "geographic", relation: "selected", storeName: "fileSearchStores/reviewed-test" }] };
function request(overrides: Record<string, unknown> = {}, origin = "http://localhost:3000") {
  return new Request("http://localhost:3000/api/chat", { method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ query: "How much notice must my employer give before terminating my two-year contract?", jurisdictionId: PILOT_CATALOG.jurisdictionId,
      externalId: "existing-chat", userClientId: "user-message", assistantClientId: "assistant-message", messages: [], historyComplete: true, attachmentIds: [], ...overrides }) });
}
const events = async (response: Response) => (await response.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
function mutation(name: string) { return mocks.fetchAuthMutation.mock.calls.find(([reference]) => getFunctionName(reference) === name)?.[1]; }
function stageVerdict(stage: StageRequest["stage"], data: StageRequest["data"]) {
  const claims = data.inventory?.segments.flatMap(segment => segment.claims) ?? [];
  return stage === "inventory"
    ? { stage: "inventory", decision: "pass", segments: data.context.segments.map((segment, index) => ({ segmentId: segment.segmentId,
      claims: [{ claimId: `claim-${index}`, status: "supported", evidenceIds: data.context.evidence.map(passage => (passage as { evidenceId: string }).evidenceId), quote: segment.text }] })) }
    : { stage, decision: "pass", partition: "accepted", claims: claims.map(claim => ({ claimId: claim.claimId,
      assessment: "preserved", scope: "overtime", ...(stage === "overtime" ? { conclusion: "none", alternatives: "not_applicable" } : {}) })) };
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries({ NODE_ENV: "development", LOCAL_REVIEWED_EMPLOYMENT_ENABLED: "1", LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED: "1",
    CONVEX_DEPLOYMENT: "dev:adventurous-hummingbird-244", NEXT_PUBLIC_CONVEX_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.cloud",
    NEXT_PUBLIC_CONVEX_SITE_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.site", GOOGLE_AI_API_KEY: "synthetic-key",
    TELEMETRY_INGEST_SECRET: "synthetic-test-secret-with-at-least-32-characters", CHAT_INTENT_ROUTING_MODE: "on" })) vi.stubEnv(key, value);
  vi.stubEnv("VERCEL", undefined);
  vi.stubEnv("LOCAL_REVIEWED_EMPLOYMENT_SPLIT_ENABLED", undefined);
  mocks.streamFactory.mockImplementation(() => mocks.stage);
  mocks.stage.mockImplementation(async (stage: StageRequest) => {
    const value = stageVerdict(stage.stage, stage.data);
    return { binding: stage.binding, status: "completed", json: JSON.stringify(value), usage: { input: 12, output: 5, thought: 7 } };
  });
  mocks.isAuthenticated.mockResolvedValue(true); mocks.getToken.mockResolvedValue("synthetic-session-token");
  mocks.loadChatAttachmentContext.mockResolvedValue({ attachments: [], attachmentIds: [], selectedJurisdiction: { id: PILOT_CATALOG.jurisdictionId, name: "Ghana", kind: "geographic" } });
  mocks.fetchAuthQuery.mockImplementation(async (reference, args) => {
    if (getFunctionName(reference) !== "reviewedEmployment:authorizeSource") throw new Error("Unexpected authorization query");
    return { status: "authorized", externalId: args.externalId, ...PILOT_CATALOG, sha256: PILOT_IDENTITY.originalSha256,
      byteSize: PILOT_IDENTITY.originalByteLength, asOfDate: args.asOfDate, resourceEffectiveDate: null, resourceRepealDate: null, versionEffectiveDate: null, versionRepealDate: null };
  });
  mocks.fetchAuthMutation.mockImplementation(async (reference, args) => {
    const name = getFunctionName(reference);
    if (name === "usage:recordQuestion") return { used: 1 };
    if (name === "chats:appendMessages") return { id: args.externalId };
    const completion = name === "reviewedEmploymentCompletion:commit" ? args.completion : args;
    if (name === "chats:completeGovernedInteraction" || name === "reviewedEmploymentCompletion:commit") return { status: "completed", outcome: "success", answerKind: completion.answerKind,
      ...(name === "reviewedEmploymentCompletion:commit" ? { persisted: true } : {}),
      citations: completion.citations.map((citation: { pageNumber: number }) => ({ label: `Labour Act, page ${citation.pageNumber}`, jurisdictionId: PILOT_CATALOG.jurisdictionId,
        jurisdictionName: "Ghana", jurisdictionKind: "geographic", relation: "selected" })), partialCoverage: false, citationClaim: claim, expiresAt: Date.now() + 60_000 };
    throw new Error("Unexpected mutation");
  });
  mocks.create.mockImplementation(async (params) => {
    const payload = JSON.parse(params.input);
    const value = payload.segments ? { decision: "pass", segments: payload.segments.map((segment: { segmentId: string }, index: number) => ({ segmentId: segment.segmentId,
      claims: [{ claimId: `claim-${index}`, status: "supported", evidenceIds: payload.evidence.map((passage: { evidenceId: string }) => passage.evidenceId) }] })) } : { candidate: answer };
    return { id: "synthetic-response", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(value) }] }] };
  });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(manifest)));
});

describe("disabled development split-verifier integration", () => {
  const overtime = () => request({ query: "Can my employer require overtime while I am pregnant?" });
  const enable = () => vi.stubEnv("LOCAL_REVIEWED_EMPLOYMENT_SPLIT_ENABLED", "1");

  it("keeps reviewed context preparation on the original 90-second cutoff", async () => {
    vi.useFakeTimers();
    mocks.loadChatAttachmentContext.mockReturnValue(new Promise(() => undefined));
    let responseSettled = false;
    const response = POST(overtime()).then(value => { responseSettled = true; return value; });
    await vi.advanceTimersByTimeAsync(89_999);
    expect(responseSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await response).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not revive a reviewed request discovered after its original deadlines", async () => {
    vi.useFakeTimers();
    mocks.isAuthenticated.mockImplementationOnce(() => new Promise(resolve => {
      setTimeout(() => resolve(true), 111_000);
    }));
    const response = POST(overtime());
    await vi.advanceTimersByTimeAsync(111_000);
    expect((await response).status).toBe(500);
    expect(mocks.loadChatAttachmentContext).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, "0", "true"])("does not construct the split executor when the flag is %s", async flag => {
    vi.stubEnv("LOCAL_REVIEWED_EMPLOYMENT_SPLIT_ENABLED", flag);
    expect((await events(await POST(request()))).at(-1)).toMatchObject({ type: "done", persisted: true });
    expect(mocks.streamFactory).not.toHaveBeenCalled(); expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it("requires all three stages and the atomic save before releasing any text", async () => {
    enable();
    const original = mocks.fetchAuthMutation.getMockImplementation()!;
    let finishSave!: (value: unknown) => void;
    mocks.fetchAuthMutation.mockImplementation((reference, args) => getFunctionName(reference) === "reviewedEmploymentCompletion:commit"
      ? new Promise(resolve => { finishSave = resolve; }) : original(reference, args));
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await POST(overtime());
    const reader = response.body!.getReader(); let released = false;
    const first = reader.read().then(value => { released = true; return value; });
    await vi.waitFor(() => expect(finishSave).toBeTypeOf("function"));
    expect(released).toBe(false);
    expect(mocks.stage.mock.calls.map(([stage]) => stage.stage)).toEqual(["inventory", "consent", "overtime"]);
    expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.get).not.toHaveBeenCalled();
    const [transport] = mocks.streamFactory.mock.calls[0];
    expect(transport.entered).toEqual({ wall: expect.any(Number), mono: expect.any(Number) });
    for (const [stage] of mocks.stage.mock.calls) expect(stage.deadlineAt).toBe(transport.entered.wall + 85_000);
    const saved = mutation("reviewedEmploymentCompletion:commit");
    expect(saved.completion).toMatchObject({ finalAnswer: answer, assistantClientId: "assistant-message", answerKind: "legal" });
    expect(saved.user.clientId).toBe("user-message");
    const reference = mocks.fetchAuthMutation.mock.calls.find(([ref]) => getFunctionName(ref) === "reviewedEmploymentCompletion:commit")![0];
    finishSave(await original(reference, saved));
    expect(JSON.parse(new TextDecoder().decode((await first).value))).toEqual({ type: "delta", text: answer });
    expect(JSON.parse(new TextDecoder().decode((await reader.read()).value))).toMatchObject({ type: "done", persisted: true, result: answer, answerKind: "legal" });
    expect(mocks.fetchAuthMutation.mock.calls.filter(([ref]) => getFunctionName(ref) === "reviewedEmploymentCompletion:commit")).toHaveLength(1);
    expect(mocks.stage.mock.calls.map(([stage]) => stage.generation_config)).toEqual([
      { thinking_level: "low", max_output_tokens: 8192 },
      { thinking_level: "medium", max_output_tokens: 8192 },
      { thinking_level: "medium", max_output_tokens: 8192 },
    ]);
    expect(transport.thinkingPolicy).toBe("inventory_low");
    expect(mocks.create.mock.calls[0][0].generation_config).toMatchObject({ thinking_level: "medium", max_output_tokens: 4096 });
    const diagnostic = JSON.parse(log.mock.calls.find(([label]) => label === "chat_request_completed")![1]).reviewed;
    expect(diagnostic).toMatchObject({ callCounts: { draftInvocations: 1, verifierInvocations: 1 }, verifier: { attemptCount: null },
      splitVerifier: { kind: "split", decision: "pass", executorInvocations: 3 } });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE|synthetic-key|existing-chat|claim-0/);
  });

  it.each(["incomplete", "changed identity", "withhold", "provider failure"])("withholds the answer and save for %s without fallback", async scenario => {
    enable(); const original = mocks.stage.getMockImplementation()!;
    mocks.stage.mockImplementation(async (stage: StageRequest, signal: AbortSignal) => {
      if (stage.stage !== "consent") return original(stage, signal);
      if (scenario === "provider failure") throw new Error("PRIVATE provider error");
      const result = await original(stage, signal);
      if (scenario === "incomplete") return { ...result, status: "in_progress" };
      if (scenario === "changed identity") return { ...result, binding: { ...stage.binding } };
      const verdict = JSON.parse(result.json);
      verdict.decision = "withhold"; verdict.partition = "rejected";
      return { ...result, json: JSON.stringify(verdict) };
    });
    const output = await events(await POST(overtime()));
    expect(output.every(event => event.type === "error")).toBe(true);
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE|persisted|synthetic/);
    expect(mutation("reviewedEmploymentCompletion:commit")).toBeUndefined();
    expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.stage.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("cancels outstanding audits when the response reader is cancelled", async () => {
    enable(); const original = mocks.stage.getMockImplementation()!;
    const signals: AbortSignal[] = [];
    mocks.stage.mockImplementation((stage: StageRequest, signal: AbortSignal) => {
      if (stage.stage === "inventory") return original(stage, signal);
      signals.push(signal);
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    const response = await POST(overtime());
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    await response.body!.cancel();
    await vi.waitFor(() => expect(signals.every(signal => signal.aborted)).toBe(true));
    expect(mutation("reviewedEmploymentCompletion:commit")).toBeUndefined();
    expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.get).not.toHaveBeenCalled();
  });

  it("withholds all text when the save fails after a complete pass", async () => {
    enable(); const original = mocks.fetchAuthMutation.getMockImplementation()!;
    mocks.fetchAuthMutation.mockImplementation((reference, args) => getFunctionName(reference) === "reviewedEmploymentCompletion:commit"
      ? Promise.reject(new Error("PRIVATE save failure")) : original(reference, args));
    const output = await events(await POST(overtime()));
    expect(output.every(event => event.type === "error")).toBe(true);
    expect(mocks.stage).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE|persisted/);
  });

  it.each(["approval", "origin", "backend", "vercel", "authentication"])("preserves the %s admission boundary", async scenario => {
    enable();
    if (scenario === "approval") vi.stubEnv("LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED", "0");
    if (scenario === "backend") vi.stubEnv("CONVEX_DEPLOYMENT", "dev:wrong");
    if (scenario === "vercel") vi.stubEnv("VERCEL", "1");
    if (scenario === "authentication") mocks.isAuthenticated.mockResolvedValue(false);
    const input = scenario === "origin" ? request({ query: "Can my employer require overtime while I am pregnant?" }, "https://external.test") : overtime();
    expect((await POST(input)).status).toBe(scenario === "authentication" ? 401 : 403);
    expect(mocks.streamFactory).not.toHaveBeenCalled(); expect(mocks.stage).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });

  it("leaves the production route without a split executor even if the flag is set", async () => {
    enable(); vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(GeminiFileSearchChat.prototype, "run").mockResolvedValue({ answer: "ordinary answer", citations: [] } as never);
    await events(await POST(overtime()));
    expect(mocks.streamFactory).not.toHaveBeenCalled(); expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("withholds unsupported reviewed conditions before drafting without a fallback", async () => {
    enable();
    const output = await events(await POST(request()));
    expect(output.every(event => event.type === "error")).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.streamFactory).not.toHaveBeenCalled(); expect(mocks.stage).not.toHaveBeenCalled();
    expect(mutation("reviewedEmploymentCompletion:commit")).toBeUndefined();
  });

  it.each(["complete", "incomplete"])("connects the real streaming adapter to the route, gate and save for %s SSE", async mode => {
    enable();
    const actual = await vi.importActual<typeof import("@/lib/source-verification/split-verification/streaming")>("@/lib/source-verification/split-verification/streaming");
    mocks.streamFactory.mockImplementation(actual.createStreamingStageExecutor);
    const providerStages: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) !== "https://generativelanguage.googleapis.com/v1beta/interactions") return Response.json(manifest);
      const body = JSON.parse(String(init!.body));
      expect(init).toMatchObject({ method: "POST", redirect: "error" });
      expect(body).toMatchObject({ stream: true, store: false });
      const stage = body.system_instruction.endsWith("Fixed stage: inventory.") ? "inventory"
        : body.system_instruction.endsWith("Fixed stage: consent.") ? "consent" : "overtime";
      providerStages.push(stage);
      const rows = [
        { event_type: "interaction.created", interaction: { model: "gemini-3.8-flash", object: "interaction" } },
        { event_type: "interaction.status_update", status: "in_progress" },
        { event_type: "step.start", index: 0, step: { type: "model_output", content: [] } },
        { event_type: "step.delta", index: 0, delta: { type: "text", text: JSON.stringify(stageVerdict(stage, JSON.parse(body.input))) } },
        { event_type: "step.stop", index: 0 },
        { event_type: "interaction.completed", interaction: { status: "completed",
          usage: { total_input_tokens: 12, total_output_tokens: 5, total_thought_tokens: 7, total_cached_tokens: 0, total_tool_use_tokens: 0, total_tokens: 24 } } },
      ];
      if (mode === "incomplete" && stage === "consent") rows.pop();
      return new Response(rows.map(row => `event: ${row.event_type}\ndata: ${JSON.stringify(row)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }));
    const output = await events(await POST(overtime()));
    expect(providerStages).toEqual(["inventory", "consent", "overtime"]);
    expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.stage).not.toHaveBeenCalled();
    if (mode === "complete") {
      expect(output.at(-1)).toMatchObject({ type: "done", result: answer, persisted: true });
      expect(mutation("reviewedEmploymentCompletion:commit").completion.finalAnswer).toBe(answer);
    } else {
      expect(output.every(event => event.type === "error")).toBe(true);
      expect(mutation("reviewedEmploymentCompletion:commit")).toBeUndefined();
    }
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("normal local reviewed employment route", () => {
  it.each([false, true])("logs only projected completed diagnostics after a saved reviewed answer (usage returned: %s)", async withUsage => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const provider = mocks.create.getMockImplementation()!;
    mocks.create.mockImplementation(async params => ({ ...await provider(params),
      ...(withUsage ? { usage: { total_input_tokens: 2742, total_output_tokens: 145, total_thought_tokens: 3934, private: "PRIVATE usage extra" } } : {}),
      finish_reason: "PRIVATE finish detail", private: "PRIVATE response extra" }));
    const output = await events(await POST(request({ query: "PRIVATE user facts: how much notice must my employer give before terminating my two-year contract?" })));
    expect(output.at(-1)).toMatchObject({ type: "done", result: answer, persisted: true });
    for (const key of ["diagnostics", "reviewed", "responseStatus", "usage"]) expect(output.at(-1)).not.toHaveProperty(key);
    const entries = log.mock.calls.filter(([label]) => label === "chat_request_completed");
    expect(entries).toHaveLength(1);
    const completed = JSON.parse(entries[0][1]);
    expect(completed.reviewed).toMatchObject({ version: 1, stage: "complete", reason: "verified",
      callCounts: { draftInvocations: 1, verifierInvocations: 1 }, draft: { attemptCount: 1 },
      verifier: { attemptCount: 1, responseStatus: "completed" } });
    for (const stage of ["draft", "verifier"]) {
      if (withUsage) expect(completed.reviewed[stage].usage).toEqual({ total_input_tokens: 2742, total_output_tokens: 145, total_thought_tokens: 3934 });
      else expect(completed.reviewed[stage]).not.toHaveProperty("usage");
    }
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE|synthetic|fileSearchStores|existing-chat|user-message|assistant-message/);
    expect(mutation("reviewedEmploymentCompletion:commit")).toBeDefined();
    expect(mocks.create).toHaveBeenCalledTimes(2); expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls.map(([params]) => params.generation_config.max_output_tokens)).toEqual([4096, 8192]);
    for (const [, options] of mocks.create.mock.calls) expect(options.maxRetries).toBe(0);
  });
  it.each(["incomplete", "budget_exceeded", "queued", "PRIVATE provider status"])("retains safe verifier response status %s without inferring a token-limit cause", async status => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const provider = mocks.create.getMockImplementation()!;
    mocks.create.mockImplementation(async params => JSON.parse(params.input).segments ? {
      status, usage: { total_input_tokens: 2742, total_output_tokens: 145, total_thought_tokens: 3934, total_tokens: 6821 },
      finish_reason: "PRIVATE provider finish detail", incomplete_details: { reason: "PRIVATE" },
      steps: [{ type: "model_output", content: [{ type: "text", text: "PRIVATE partial verdict" }] }],
    } : provider(params));
    const output = await events(await POST(request()));
    expect(output.every(event => event.type === "error")).toBe(true);
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE|incomplete_response|budget_exceeded|queued/);
    const entries = log.mock.calls.filter(([label]) => label === "chat_request_failed");
    expect(entries).toHaveLength(1);
    const saved = JSON.parse(entries[0][1]).reviewed;
    expect(saved).toMatchObject({ stage: "verifier", reason: "incomplete_response", gateReason: "verification_rejected",
      verifier: { responseStatus: status.startsWith("PRIVATE") ? "unknown" : status, attemptCount: 1,
        usage: { total_output_tokens: 145, total_thought_tokens: 3934 } } });
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
    expect(mutation("reviewedEmploymentCompletion:commit")).toBeUndefined();
    expect(mocks.create).toHaveBeenCalledTimes(2); expect(mocks.get).not.toHaveBeenCalled();
    for (const [, options] of mocks.create.mock.calls) expect(options.maxRetries).toBe(0);
  });
  it.each([
    ["draft rejection", "draft", "provider_error", 1],
    ["draft incomplete", "draft", "incomplete_response", 1],
    ["verifier invalid", "verifier", "invalid_verdict", 2],
    ["verifier unsupported", "verifier", "unsupported_claim", 2],
    ["authority rejection", "initial_authority", "authority_unavailable", 0],
    ["commit rejection", "commit", "dependency_failed", 2],
  ] as const)("retains private stage diagnostics for %s without changing answer withholding", async (scenario, stage, reason, attempts) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const provider = mocks.create.getMockImplementation()!;
    if (scenario === "draft rejection") mocks.create.mockRejectedValueOnce(new Error("PRIVATE provider detail synthetic-key"));
    if (scenario === "draft incomplete") mocks.create.mockResolvedValueOnce({ status: "in_progress", private: "PRIVATE" });
    if (scenario.startsWith("verifier")) mocks.create.mockImplementation(async params => {
      const payload = JSON.parse(params.input);
      if (!payload.segments) return provider(params);
      const verdict = scenario === "verifier invalid" ? { private: "PRIVATE" } : { decision: "withhold",
        segments: payload.segments.map((segment: { segmentId: string }, index: number) => ({ segmentId: segment.segmentId,
          claims: [{ claimId: `claim-${index}`, status: "insufficient_evidence", evidenceIds: [] }] })) };
      return { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(verdict) }] }],
        usage: { total_input_tokens: 123, total_output_tokens: 45, private: "PRIVATE" } };
    });
    if (scenario === "authority rejection") mocks.fetchAuthQuery.mockRejectedValueOnce(new Error("PRIVATE authority detail"));
    if (scenario === "commit rejection") {
      const original = mocks.fetchAuthMutation.getMockImplementation()!;
      mocks.fetchAuthMutation.mockImplementation((reference, args) => getFunctionName(reference) === "reviewedEmploymentCompletion:commit"
        ? Promise.reject(new Error("PRIVATE save detail")) : original(reference, args));
    }
    const output = await events(await POST(request()));
    expect(output.every(event => event.type === "error")).toBe(true);
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE|synthetic|diagnostics|provider_error|invalid_verdict/);
    const entry = log.mock.calls.filter(([label]) => label === "chat_request_failed");
    expect(entry).toHaveLength(1);
    const logged = JSON.parse(entry[0][1]);
    expect(logged.reviewed).toMatchObject({ version: 1, stage, reason,
      callCounts: { draftInvocations: attempts ? 1 : 0, verifierInvocations: attempts === 2 ? 1 : 0 } });
    expect(logged.phase).toBe(stage === "commit" ? "completion" : "generation");
    if (stage === "draft" || stage === "verifier") {
      expect(logged.reviewed[stage]).toMatchObject({ attemptCount: 1,
        timingMs: { preparation: expect.any(Number), provider: expect.any(Number), validation: expect.any(Number), total: expect.any(Number) } });
    }
    if (stage === "verifier") expect(logged.reviewed.verifier.usage).toEqual({ total_input_tokens: 123, total_output_tokens: 45 });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE|synthetic|fileSearchStores|existing-chat|user-message|assistant-message/);
    expect(mocks.create).toHaveBeenCalledTimes(attempts); expect(mocks.get).not.toHaveBeenCalled();
    if (stage !== "commit") expect(mutation("reviewedEmploymentCompletion:commit")).toBeUndefined();
  });
  it("saves exact user and assistant IDs and answer before releasing its first delta", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let finishSave!: (value: unknown) => void;
    const original = mocks.fetchAuthMutation.getMockImplementation()!;
    mocks.fetchAuthMutation.mockImplementation((reference, args) => getFunctionName(reference) === "reviewedEmploymentCompletion:commit"
      ? new Promise(resolve => { finishSave = resolve; }) : original(reference, args));
    const response = await POST(request()); expect(response.status).toBe(200);
    const reader = response.body!.getReader(); let released = false;
    const first = reader.read().then(value => { released = true; return value; });
    await vi.waitFor(() => expect(finishSave).toBeTypeOf("function")); expect(released).toBe(false);
    expect(log.mock.calls.filter(([label]) => label === "chat_request_completed")).toHaveLength(0);
    const saved = mutation("reviewedEmploymentCompletion:commit");
    expect(saved.user).toMatchObject({ clientId: "user-message", attachmentIds: [] });
    expect(saved.completion).toMatchObject({ assistantClientId: "assistant-message", finalAnswer: answer });
    expect(saved.source).toMatchObject({ ...PILOT_CATALOG, expectedSha256: PILOT_IDENTITY.originalSha256, expectedByteSize: PILOT_IDENTITY.originalByteLength });
    const reference = mocks.fetchAuthMutation.mock.calls.find(([ref]) => getFunctionName(ref) === "reviewedEmploymentCompletion:commit")![0];
    finishSave(await original(reference, saved));
    expect(JSON.parse(new TextDecoder().decode((await first).value))).toEqual({ type: "delta", text: answer });
    const done = JSON.parse(new TextDecoder().decode((await reader.read()).value));
    expect(done).toMatchObject({ type: "done", result: answer, persisted: true, citationClaim: claim, answerKind: "legal" });
    expect(log.mock.calls.filter(([label]) => label === "chat_request_completed")).toHaveLength(1);
    expect(mocks.create).toHaveBeenCalledTimes(2); expect(mocks.get).not.toHaveBeenCalled();
    for (const [, options] of mocks.create.mock.calls) expect(options.maxRetries).toBe(0);
  });
  it("withholds the draft and persisted marker after claim consumption or save failure", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const original = mocks.fetchAuthMutation.getMockImplementation()!;
    mocks.fetchAuthMutation.mockImplementation((reference, args) => getFunctionName(reference) === "reviewedEmploymentCompletion:commit"
      ? Promise.reject(new Error("attachment revoked")) : original(reference, args));
    const output = await events(await POST(request()));
    expect(output.every(event => event.type === "error")).toBe(true); expect(JSON.stringify(output)).not.toContain("PRIVATE");
    expect(log.mock.calls.filter(([label]) => label === "chat_request_completed")).toHaveLength(0);
  });
  it("keeps follow-up chronology and prior attachments, binding only new uploads to the new user", async () => {
    const text = "Employer says two days' notice for my two-year contract.";
    mocks.loadChatAttachmentContext.mockResolvedValue({ attachments: [{ id: "prior-file", filename: "letter.txt", mimeType: "text/plain", kind: "text", text }],
      attachmentIds: ["prior-file"], selectedJurisdiction: { id: PILOT_CATALOG.jurisdictionId, name: "Ghana", kind: "geographic" } });
    const history = [{ role: "user", content: "My employer gave notice on a two-year contract." }, { role: "assistant", content: "Unsupported old assertion." }];
    expect((await events(await POST(request({ query: "Actually, it was a six-month contract. Does that change the notice?", messages: history })))).at(-1).persisted).toBe(true);
    const payloads = mocks.create.mock.calls.map(([params]) => JSON.parse(params.input));
    expect(payloads[0].question).toBe(payloads[1].question); expect(payloads[0].user_facts).toBe(payloads[1].facts);
    expect(payloads[0].user_facts).toContain(text); expect(payloads[0].user_facts).toContain("Unsupported old assertion");
    expect(mutation("reviewedEmploymentCompletion:commit").completion.attachmentIds).toEqual(["prior-file"]);
    expect(mutation("reviewedEmploymentCompletion:commit").user.attachmentIds).toEqual([]);
  });
  it.each(["What are Ghana's tenant eviction rules?", "What is the capital of France?", "What income tax rate applies to a small online shop in Ghana?"])("completes a saveable uncited coverage notice without provider or usage for %s", async query => {
    vi.stubEnv("CHAT_INTENT_ROUTING_MODE", "shadow");
    vi.stubEnv("TYPESAFE_API_KEY", "synthetic-classifier-key");
    const response = await POST(request({ query })); expect(response.status).toBe(200);
    const output = await events(response);
    expect(output.at(-1)).toMatchObject({ type: "done", answerKind: "policy", citations: [], citationClaim: claim,
      result: "The reviewed material available here does not cover this question well enough to give a verified answer.", partialCoverage: false });
    expect(mutation("chats:completeGovernedInteraction")).toMatchObject({ outcome: "success", answerKind: "policy", model: "app-policy-v1", citations: [] });
    expect(mutation("usage:recordQuestion")).toBeUndefined();
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.fetchAuthQuery).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("withholds the coverage notice when its completion claim cannot be issued", async () => {
    mocks.fetchAuthMutation.mockRejectedValue(new Error("PRIVATE authorization failure"));
    const output = await events(await POST(request({ query: "What income tax applies to a shop?" })));
    expect(output.every(event => event.type === "error")).toBe(true);
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE|reviewed material/);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mutation("usage:recordQuestion")).toBeUndefined();
  });
  it.each([false, undefined])("withholds when conversation completeness is %s before provider work or billing", async historyComplete => {
    const response = await POST(request({ historyComplete })); expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.fetchAuthMutation).not.toHaveBeenCalled();
  });
  it("keeps all twenty supplied turns including earlier corrections in both model contexts", async () => {
    const history = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `Earlier context ${index}.` }));
    history[0].content = "My employer hired me for three years.";
    history[10].content = "Correction: that contract was for six months.";
    expect((await events(await POST(request({ messages: history })))).at(-1).persisted).toBe(true);
    const [draft, verify] = mocks.create.mock.calls.map(([params]) => JSON.parse(params.input));
    expect(JSON.parse(draft.user_facts).history).toHaveLength(20); expect(verify.facts).toBe(draft.user_facts);
    expect(draft.user_facts).toContain(history[0].content); expect(draft.user_facts).toContain(history[10].content);
  });
  it("blocks paid dispatch and question billing when the approval flag is off, including intent classification", async () => {
    vi.stubEnv("LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED", undefined);
    expect((await POST(request())).status).toBe(403); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.fetchAuthMutation).not.toHaveBeenCalled();
  });
  it("requires explicit paid approval for local document-only validation too", async () => {
    vi.stubEnv("LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED", undefined);
    mocks.loadChatAttachmentContext.mockResolvedValue({ attachments: [{ id: "text", filename: "letter.txt", mimeType: "text/plain", kind: "text", text: "Friday." }],
      attachmentIds: ["text"], selectedJurisdiction: { id: PILOT_CATALOG.jurisdictionId, name: "Ghana", kind: "geographic" } });
    const run = vi.spyOn(GeminiFileSearchChat.prototype, "run");
    expect((await POST(request({ query: "Summarize this letter", attachmentIds: ["text"] }))).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.fetchAuthMutation).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });
  it("requires the supplied user ID and exact same-origin local request before paid dispatch", async () => {
    expect((await POST(request({ userClientId: undefined }))).status).toBe(400);
    expect((await POST(request({}, "https://external.test"))).status).toBe(403); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("rejects binary-only legal attachments and mixed summary/legal requests before a provider call", async () => {
    mocks.loadChatAttachmentContext.mockResolvedValue({ attachments: [{ id: "pdf", filename: "contract.pdf", mimeType: "application/pdf", kind: "document", data: "AA==" }],
      attachmentIds: ["pdf"], selectedJurisdiction: { id: PILOT_CATALOG.jurisdictionId, name: "Ghana", kind: "geographic" } });
    const response = await POST(request({ query: "Summarize my contract and explain whether my employer can fire me.", attachmentIds: ["pdf"] }));
    expect(response.status).toBe(400); expect((await response.json()).error).toMatch(/readable text/i); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("preserves document-only dispatch with no legal citations and client persistence", async () => {
    mocks.loadChatAttachmentContext.mockResolvedValue({ attachments: [{ id: "text", filename: "letter.txt", mimeType: "text/plain", kind: "text", text: "Your contract ends Friday." }],
      attachmentIds: ["text"], selectedJurisdiction: { id: PILOT_CATALOG.jurisdictionId, name: "Ghana", kind: "geographic" } });
    const run = vi.spyOn(GeminiFileSearchChat.prototype, "run").mockResolvedValue({ answer: "Your contract ends Friday.", citations: [] } as never);
    const output = await events(await POST(request({ query: "Summarize this letter", attachmentIds: ["text"] })));
    expect(output.at(-1)).toMatchObject({ type: "done", answerKind: "document", citations: [] }); expect(output.at(-1)).not.toHaveProperty("persisted");
    expect(run).toHaveBeenCalledTimes(1); expect(run.mock.calls[0][1]).toMatchObject({ singleAttempt: true });
    expect(mocks.fetchAuthQuery).not.toHaveBeenCalled(); expect(mutation("chats:appendMessages")).toBeUndefined();
  });
});
