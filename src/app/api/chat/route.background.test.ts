// @vitest-environment node
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ isAuthenticated: vi.fn(), getToken: vi.fn(), fetchAuthMutation: vi.fn(), fetchAuthQuery: vi.fn(),
  loadChatAttachmentContext: vi.fn(), after: vi.fn(), worker: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/auth-server", () => mocks);
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/rate-limit", () => ({ clientKey: () => "background-route-test", rateLimit: () => ({ ok: true }) }));
vi.mock("@/lib/source-verification/reviewed-employment-job-worker", () => ({ runReviewedEmploymentJob: mocks.worker }));
vi.mock("@/lib/chat-attachment-server", async original => ({ ...await original<typeof import("@/lib/chat-attachment-server")>(), loadChatAttachmentContext: mocks.loadChatAttachmentContext }));
vi.mock("@google/genai", () => ({ GoogleGenAI: class { interactions = { create: mocks.create }; } }));

import { POST, maxDuration } from "./route";
import { GET } from "./background/route";
import { PILOT_CATALOG } from "@/lib/source-verification/reviewed-source-cases";
import { reviewedEmploymentJobSubmitProofParts } from "../../../../shared/reviewed-employment-jobs";
import { verifyTelemetryServiceProof } from "../../../../convex/lib/telemetryProof";
import { CHAT_NO_EVIDENCE } from "../../../../convex/lib/chatNoEvidence";
import { GeminiFileSearchChat } from "@/lib/gemini-file-search-chat";

const query = "Can my employer require overtime while I am pregnant?";
const createdAt = Date.now();
const projection = { jobId: "saved-job", externalId: "existing-chat", userClientId: "user-message", assistantClientId: "assistant-message", question: query,
  status: "queued", progress: "queued", createdAt, verificationDeadlineAt: createdAt + 240_000, terminalDeadlineAt: createdAt + 270_000, errorReason: null };
function request(overrides: Record<string, unknown> = {}, options: { signal?: AbortSignal; origin?: string } = {}) {
  return new Request("http://localhost:3000/api/chat", { method: "POST", headers: { origin: options.origin ?? "http://localhost:3000", "content-type": "application/json" }, signal: options.signal,
    body: JSON.stringify({ query, jurisdictionId: PILOT_CATALOG.jurisdictionId, externalId: "existing-chat", userClientId: "user-message", assistantClientId: "assistant-message",
      messages: [], historyComplete: true, attachmentIds: [], ...overrides }) });
}
const names = () => mocks.fetchAuthMutation.mock.calls.map(([ref]) => getFunctionName(ref));
beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries({ NODE_ENV: "development", LOCAL_REVIEWED_EMPLOYMENT_ENABLED: "1", LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED: "1", LOCAL_REVIEWED_EMPLOYMENT_SPLIT_ENABLED: "1", LOCAL_REVIEWED_EMPLOYMENT_BACKGROUND_ENABLED: "1",
    CONVEX_DEPLOYMENT: "dev:adventurous-hummingbird-244", NEXT_PUBLIC_CONVEX_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.cloud", NEXT_PUBLIC_CONVEX_SITE_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.site",
    TELEMETRY_INGEST_SECRET: "synthetic-background-test-secret-at-least-32-characters", CHAT_INTENT_ROUTING_MODE: "off" })) vi.stubEnv(key, value);
  vi.stubEnv("VERCEL", undefined);
  mocks.isAuthenticated.mockResolvedValue(true); mocks.getToken.mockResolvedValue("synthetic-private-session");
  mocks.worker.mockResolvedValue(undefined);
  mocks.loadChatAttachmentContext.mockResolvedValue({ attachments: [], attachmentIds: [], selectedJurisdiction: { id: PILOT_CATALOG.jurisdictionId, name: "Ghana", kind: "geographic" } });
  mocks.fetchAuthMutation.mockImplementation(async ref => {
    if (getFunctionName(ref) === "reviewedEmploymentJobs:submit") return projection;
    throw new Error("Unexpected legacy mutation");
  });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ authorizedScopeSize: 1, partialCoverage: false, stores: [{ jurisdictionId: PILOT_CATALOG.jurisdictionId, name: "Ghana", kind: "geographic", relation: "selected", storeName: "fileSearchStores/test" }] })));
});

describe("limited production section 55 admission", () => {
  const jurisdictionId = "md791bzzqyzd0qdtman23jar7d8ds244";
  const productionRequest = (overrides: Record<string, unknown> = {}, origin = "https://lawoftheland.vercel.app") => new Request("https://lawoftheland.vercel.app/api/chat", {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ query, jurisdictionId,
      externalId: "existing-chat", userClientId: "user-message", assistantClientId: "assistant-message", messages: [], historyComplete: true, attachmentIds: [], ...overrides }),
  });
  beforeEach(() => {
    for (const [key, value] of Object.entries({ NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production",
      NEXT_PUBLIC_CONVEX_URL: "https://loyal-koala-720.eu-west-1.convex.cloud", NEXT_PUBLIC_CONVEX_SITE_URL: "https://loyal-koala-720.eu-west-1.convex.site",
      REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED: "1", REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED: "1",
      LOCAL_REVIEWED_EMPLOYMENT_ENABLED: "0", LOCAL_REVIEWED_EMPLOYMENT_BACKGROUND_ENABLED: "0", LOCAL_REVIEWED_EMPLOYMENT_SPLIT_ENABLED: "0", LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED: "0", GOOGLE_AI_API_KEY: "synthetic-production-test-key" })) vi.stubEnv(key, value);
    vi.stubEnv("CONVEX_DEPLOYMENT", undefined);
    mocks.loadChatAttachmentContext.mockResolvedValue({ attachments: [], attachmentIds: [], selectedJurisdiction: { id: jurisdictionId, name: "Ghana", kind: "geographic" } });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ authorizedScopeSize: 1, partialCoverage: false, stores: [{ jurisdictionId, name: "Ghana", kind: "geographic", relation: "selected", storeName: "fileSearchStores/test" }] })));
  });
  const ordinaryAnswer = () => {
    const run = vi.spyOn(GeminiFileSearchChat.prototype, "run").mockResolvedValue({ answer: CHAT_NO_EVIDENCE, citations: [] } as never);
    mocks.fetchAuthMutation.mockImplementation(async (ref, args) => {
      if (getFunctionName(ref) === "usage:recordQuestion") return { used: 1 };
      if (getFunctionName(ref) === "chats:completeGovernedInteraction") return { status: "completed", outcome: "success", answerKind: args.answerKind, citations: [], partialCoverage: false, citationClaim: "c".repeat(43), expiresAt: Date.now() + 60_000 };
      throw new Error("Unexpected reviewed mutation");
    });
    return run;
  };

  it.each([undefined, "provisional-v1"])("admits Ghana overtime as a saved background job with streaming %s", async streaming => {
    const response = await POST(productionRequest(streaming ? { streaming } : {}));
    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ type: "background_job", jobId: projection.jobId, status: "queued" });
    expect(names()).toEqual(["reviewedEmploymentJobs:submit"]);
    expect(mocks.fetchAuthMutation.mock.calls[0][1].jurisdictionId).toBe(jurisdictionId);
    const selection = JSON.parse(mocks.fetchAuthMutation.mock.calls[0][1].submission).selection;
    expect(selection.topics).toEqual(["overtime"]);
    expect(selection.requests).toHaveLength(1);
    expect(selection.requests[0].reviewedSpanId).toBe("p18-s55-1-2");
    expect(mocks.after).toHaveBeenCalledTimes(1); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("rejects a foreign production Origin before saved work", async () => {
    expect((await POST(productionRequest({}, "https://foreign.example"))).status).toBe(403);
    expect(names()).toEqual([]); expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(["How much notice must my employer give?", "Can they require overtime and relocate me?", "What is the tax rate?"])("keeps %s on the existing answer path without reviewed history guards", async question => {
    const run = ordinaryAnswer();
    const response = await POST(productionRequest({ query: question, historyComplete: false, userClientId: undefined }));
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const output = await response.text(); expect(output).toContain(CHAT_NO_EVIDENCE);
    expect(names()).toEqual(["usage:recordQuestion", "chats:completeGovernedInteraction"]);
    expect(run).toHaveBeenCalledTimes(1); expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(["REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED", "REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED"])("keeps Ghana on the existing path after %s is disabled without a synchronous reviewed fallback", async flag => {
    vi.stubEnv(flag, "0"); const run = ordinaryAnswer();
    const response = await POST(productionRequest()); await response.text();
    expect(run).toHaveBeenCalledTimes(1); expect(names()).toEqual(["usage:recordQuestion", "chats:completeGovernedInteraction"]);
    expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("preserves content-only document mode even when prior history selected overtime", async () => {
    const run = ordinaryAnswer();
    mocks.loadChatAttachmentContext.mockResolvedValue({ attachments: [{ id: "letter", filename: "letter.txt", mimeType: "text/plain", kind: "text", text: "My employer asks me to work overtime." }], attachmentIds: ["letter"], selectedJurisdiction: { id: jurisdictionId, name: "Ghana", kind: "geographic" } });
    const response = await POST(productionRequest({ query: "Summarize this file.", messages: [{ role: "user", content: query }], historyComplete: false, userClientId: undefined, attachmentIds: ["letter"] }, "https://foreign.example"));
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const output = await response.text(); expect(output).toContain('"answerKind":"document"');
    expect(run).toHaveBeenCalledTimes(1); expect(run.mock.calls[0][0]).toMatchObject({ answerKind: "document" });
    expect(run.mock.calls[0][1]).not.toHaveProperty("singleAttempt");
    expect(names()).toEqual(["usage:recordQuestion", "chats:completeGovernedInteraction"]); expect(mocks.after).not.toHaveBeenCalled();
  });
  it.each([
    { kind: "document", question: "Summarize this file.", history: [{ role: "user", content: query }], text: "My employer asks me to work overtime." },
    { kind: "legal", question: "Can my employer require overtime under this agreement?", history: [], text: "My employer must give written notice." },
  ])("gives an ordinary $kind answer its 180-second window after preliminary overtime selection", async ({ kind, question, history, text }) => {
    vi.useFakeTimers();
    let releaseAnswer!: () => void;
    const answer = new Promise<void>(resolve => { releaseAnswer = resolve; });
    const run = ordinaryAnswer();
    run.mockImplementation(async () => {
      await answer;
      return { answer: CHAT_NO_EVIDENCE, citations: [] } as never;
    });
    mocks.loadChatAttachmentContext.mockResolvedValue({ attachments: [{ id: "letter", filename: "letter.txt", mimeType: "text/plain", kind: "text", text }], attachmentIds: ["letter"], selectedJurisdiction: { id: jurisdictionId, name: "Ghana", kind: "geographic" } });
    const reader = (await POST(productionRequest({ query: question, messages: history, attachmentIds: ["letter"] }))).body!.getReader();
    let released = false;
    const firstRead = reader.read().then(value => { released = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(150_000);
      expect(released).toBe(false);
      releaseAnswer();
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.parse(new TextDecoder().decode((await firstRead).value))).toEqual({ type: "delta", text: CHAT_NO_EVIDENCE });
      expect(JSON.parse(new TextDecoder().decode((await reader.read()).value))).toMatchObject({ type: "done", answerKind: kind });
      await expect(reader.read()).resolves.toMatchObject({ done: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      releaseAnswer();
      await reader.cancel();
    }
  });
  it("rejects late attachment-derived reviewed selection without restarting the original deadlines", async () => {
    vi.useFakeTimers();
    let contextSignal: AbortSignal | undefined;
    mocks.loadChatAttachmentContext.mockImplementationOnce((_externalId, _ids, _token, signal: AbortSignal) => {
      contextSignal = signal;
      return new Promise(resolve => {
        setTimeout(() => resolve({ attachments: [{ id: "letter", filename: "letter.txt", mimeType: "text/plain", kind: "text", text: "My employer asks me to work overtime." }], attachmentIds: ["letter"], selectedJurisdiction: { id: jurisdictionId, name: "Ghana", kind: "geographic" } }), 100_000);
      });
    });
    const response = POST(productionRequest({ query: "Does my employer have to honour this agreement?", attachmentIds: ["letter"] }));
    await vi.advanceTimersByTimeAsync(100_000);
    expect((await response).status).toBe(500);
    expect(contextSignal?.aborted).toBe(true);
    expect(names()).toEqual([]);
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not revive expired reviewed preparation before its timer callback runs", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const run = ordinaryAnswer();
    mocks.loadChatAttachmentContext.mockImplementationOnce(async () => {
      vi.setSystemTime(startedAt + 100_000);
      return { attachments: [{ id: "letter", filename: "letter.txt", mimeType: "text/plain", kind: "text", text: "My employer asks me to work overtime." }], attachmentIds: ["letter"], selectedJurisdiction: { id: jurisdictionId, name: "Ghana", kind: "geographic" } };
    });
    const response = await POST(productionRequest({ query: "Summarize this file.", messages: [{ role: "user", content: query }], attachmentIds: ["letter"] }));
    expect(response.status).toBe(500);
    expect(run).not.toHaveBeenCalled();
    expect(names()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the ordinary fallback cutoff anchored to elapsed time after a wall-clock rollback", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    let monotonicTime = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicTime);
    const run = ordinaryAnswer();
    run.mockImplementation(() => new Promise(() => undefined));
    mocks.loadChatAttachmentContext.mockImplementationOnce(() => new Promise(resolve => {
      setTimeout(() => {
        monotonicTime = 80_000;
        vi.setSystemTime(startedAt - 60_000);
        resolve({ attachments: [{ id: "letter", filename: "letter.txt", mimeType: "text/plain", kind: "text", text: "My employer asks me to work overtime." }], attachmentIds: ["letter"], selectedJurisdiction: { id: jurisdictionId, name: "Ghana", kind: "geographic" } });
      }, 80_000);
    }));
    const response = POST(productionRequest({ query: "Summarize this file.", messages: [{ role: "user", content: query }], attachmentIds: ["letter"] }));
    await vi.advanceTimersByTimeAsync(80_000);
    const reader = (await response).body!.getReader();
    let released = false;
    const firstRead = reader.read().then(value => { released = true; return value; });
    try {
      monotonicTime = 179_999;
      await vi.advanceTimersByTimeAsync(99_999);
      expect(released).toBe(false);
      monotonicTime = 180_000;
      await vi.advanceTimersByTimeAsync(1);
      expect(released).toBe(true);
      expect(JSON.parse(new TextDecoder().decode((await firstRead).value))).toMatchObject({ type: "error", reason: "deadline_exceeded" });
      await expect(reader.read()).resolves.toMatchObject({ done: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await reader.cancel();
    }
  });
  it.each([{ historyComplete: false }, { userClientId: undefined }])("requires complete section 55 admission %o before saved work", async overrides => {
    expect((await POST(productionRequest(overrides))).status).toBe(400);
    expect(names()).toEqual([]); expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(["unreadable attachment", "attachment context limit"])("closes recognized section 55 requests with %s without falling through to ordinary answers", async scenario => {
    const run = ordinaryAnswer();
    const attachment = scenario === "unreadable attachment"
      ? { id: "file", filename: "facts.pdf", mimeType: "application/pdf", kind: "document", data: Buffer.from("synthetic PDF bytes").toString("base64") }
      : { id: "file", filename: "facts.txt", mimeType: "text/plain", kind: "text", text: "a".repeat(9000) };
    mocks.loadChatAttachmentContext.mockResolvedValue({ attachments: [attachment], attachmentIds: ["file"], selectedJurisdiction: { id: jurisdictionId, name: "Ghana", kind: "geographic" } });
    const response = await POST(productionRequest({ attachmentIds: ["file"] }));
    const output = await response.text();
    expect(response.status).toBe(400);
    const result = JSON.parse(output);
    expect(result.error).toContain(scenario === "unreadable attachment" ? "readable text" : "more detail");
    expect(run).not.toHaveBeenCalled(); expect(names()).toEqual([]); expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("POST /api/chat saved reviewed verification", () => {
  it("returns a saved JSON job without streaming an answer or charging legacy quota", async () => {
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ type: "background_job", jobId: "saved-job", status: "queued" });
    expect(names()).toEqual(["reviewedEmploymentJobs:submit"]);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(maxDuration).toBe(300);
    const [, args] = mocks.fetchAuthMutation.mock.calls[0];
    expect(args).toMatchObject({ submissionId: "assistant-message", externalId: "existing-chat", jurisdictionId: PILOT_CATALOG.jurisdictionId, userClientId: "user-message", assistantClientId: "assistant-message" });
    expect(await verifyTelemetryServiceProof(args.serviceProof, await reviewedEmploymentJobSubmitProofParts(args))).toBe(true);
    const submission = JSON.parse(args.submission);
    expect(Object.keys(submission).sort()).toEqual(["attachmentIds", "contextAttachmentIds", "facts", "historyComplete", "messages", "query", "routeNonce", "selection"]);
    expect(submission).toMatchObject({ query, historyComplete: true, messages: [], attachmentIds: [], contextAttachmentIds: [], selection: { status: "selected", question: query } });
    expect(submission.facts).toBe(submission.selection.facts);
    expect(args.submission).not.toContain("synthetic-private-session");
  });

  it("keeps admitted work running after the browser disconnects", async () => {
    const abort = new AbortController();
    const response = await POST(request({}, { signal: abort.signal }));
    expect(response.status).toBe(202);
    abort.abort();
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.worker).toHaveBeenCalledWith("saved-job");
    expect(names()).toEqual(["reviewedEmploymentJobs:submit"]);
  });

  it("clears the synchronous route deadlines after accepting a saved job", async () => {
    vi.useFakeTimers();
    expect((await POST(request())).status).toBe(202);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts an idempotent submission that is already running without legacy quota work", async () => {
    mocks.fetchAuthMutation.mockResolvedValue({ ...projection, status: "running", progress: "inventory" });
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ type: "background_job", jobId: "saved-job", status: "running" });
    expect(names()).toEqual(["reviewedEmploymentJobs:submit"]);
  });

  it("schedules a persisted job even if the browser leaves while submission is being saved", async () => {
    const abort = new AbortController();
    let finishSubmit!: (value: unknown) => void;
    mocks.fetchAuthMutation.mockReturnValue(new Promise(resolve => { finishSubmit = resolve; }));
    const pending = POST(request({}, { signal: abort.signal }));
    await vi.waitFor(() => expect(names()).toEqual(["reviewedEmploymentJobs:submit"]));
    abort.abort(); finishSubmit(projection);
    expect((await pending).status).toBe(202);
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.worker).toHaveBeenCalledWith("saved-job");
  });

  it("does not charge or submit background work after 26 seconds of preflight", async () => {
    vi.useFakeTimers();
    mocks.isAuthenticated.mockImplementationOnce(() => new Promise(resolve => { setTimeout(() => resolve(true), 26_000); }));
    const pending = POST(request());
    await vi.advanceTimersByTimeAsync(26_000);
    const response = await pending;
    expect(response.status).toBe(500); expect(await response.json()).not.toHaveProperty("type");
    expect(names()).toEqual([]); expect(mocks.after).not.toHaveBeenCalled();
  });

  it("counts monotonic preflight time even when the wall clock stays still", async () => {
    vi.useFakeTimers();
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(0);
    const context = await mocks.loadChatAttachmentContext();
    mocks.loadChatAttachmentContext.mockImplementationOnce(async () => { monotonic.mockReturnValue(26_000); return context; });
    expect((await POST(request())).status).toBe(500);
    expect(names()).toEqual([]); expect(mocks.after).not.toHaveBeenCalled();
  });

  it("closes a stalled submit at the original 25-second envelope and recovers its late saved job without resubmitting", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    let finishSubmit!: (value: unknown) => void;
    mocks.fetchAuthMutation.mockReturnValue(new Promise(resolve => { finishSubmit = resolve; }));
    let settled = false;
    const pending = POST(request()).then(response => { settled = true; return response; });
    await vi.waitFor(() => expect(names()).toEqual(["reviewedEmploymentJobs:submit"]));
    await vi.advanceTimersByTimeAsync(25_000 - (Date.now() - startedAt) - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const response = await pending;
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "We couldn't process your request. Please try again.", type: "background_job_uncertain" });
    expect(mocks.after).not.toHaveBeenCalled();
    finishSubmit(projection);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.after).not.toHaveBeenCalled();
    mocks.fetchAuthQuery.mockResolvedValue(projection);
    expect((await GET(new Request("http://localhost:3000/api/chat/background?chat=existing-chat"))).status).toBe(200);
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.worker).toHaveBeenCalledWith("saved-job");
    expect(names()).toEqual(["reviewedEmploymentJobs:submit"]);
  });

  it("preserves all complete history and separates new from resolved attachment bindings", async () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({ role: "user", content: `Employment fact ${i}` }));
    mocks.loadChatAttachmentContext.mockResolvedValue({ attachments: [{ id: "prior-file", filename: "facts.txt", mimeType: "text/plain", kind: "text", text: "I am pregnant." },
      { id: "new-file", filename: "notes.txt", mimeType: "text/plain", kind: "text", text: "My employer asks me to work overtime." }], attachmentIds: ["prior-file", "new-file"], selectedJurisdiction: { id: PILOT_CATALOG.jurisdictionId, name: "Ghana", kind: "geographic" } });
    expect((await POST(request({ messages, attachmentIds: ["new-file"] }))).status).toBe(202);
    const submission = JSON.parse(mocks.fetchAuthMutation.mock.calls[0][1].submission);
    expect(submission.messages).toEqual(messages);
    expect(submission.attachmentIds).toEqual(["new-file"]);
    expect(submission.contextAttachmentIds).toEqual(["prior-file", "new-file"]);
    expect(submission.facts).toContain("I am pregnant.");
  });

  it("requires authentication before submit and worker scheduling", async () => {
    mocks.isAuthenticated.mockResolvedValue(false);
    expect((await POST(request())).status).toBe(401);
    expect(names()).toEqual([]); expect(mocks.after).not.toHaveBeenCalled();
  });

  it.each([{ historyComplete: false }, { userClientId: undefined }])("rejects incomplete admission %o before saved work", async overrides => {
    expect((await POST(request(overrides))).status).toBe(400);
    expect(names()).toEqual([]); expect(mocks.after).not.toHaveBeenCalled();
  });

  it("rejects a foreign origin before submit", async () => {
    expect((await POST(request({}, { origin: "https://foreign.example" }))).status).toBe(403);
    expect(names()).toEqual([]);
  });

  it.each([undefined, "0", "true"])("does not submit when the background flag is %s", async flag => {
    vi.stubEnv("LOCAL_REVIEWED_EMPLOYMENT_BACKGROUND_ENABLED", flag);
    await (await POST(request())).text();
    expect(names()).not.toContain("reviewedEmploymentJobs:submit");
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it.each(["LOCAL_REVIEWED_EMPLOYMENT_SPLIT_ENABLED", "LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED"])("does not submit when %s is off", async flag => {
    vi.stubEnv(flag, "0");
    await (await POST(request())).text();
    expect(names()).not.toContain("reviewedEmploymentJobs:submit");
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it.each([["QUOTA_EXCEEDED private backend detail", 402], ["REVIEWED_EMPLOYMENT_JOB_ACTIVE private backend detail", 409], ["private backend detail", 500]])("closes submit error %s with status %s", async (message, status) => {
    mocks.fetchAuthMutation.mockRejectedValue(new Error(message));
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private backend detail");
    expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
    expect(names()).toEqual(["reviewedEmploymentJobs:submit"]);
  });

  it("withholds malformed saved-job results without scheduling a worker", async () => {
    mocks.fetchAuthMutation.mockResolvedValue({ ...projection, status: "private-result", candidate: "private answer" });
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/private-result|private answer/);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("marks a possibly accepted RPC failure for read-only recovery without replaying the submission", async () => {
    mocks.fetchAuthMutation.mockRejectedValue(new TypeError("PRIVATE network transport detail"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "We couldn't process your request. Please try again.", type: "background_job_uncertain" });
    expect(names()).toEqual(["reviewedEmploymentJobs:submit"]); expect(mocks.after).not.toHaveBeenCalled();
  });

  it.each(["REVIEWED_EMPLOYMENT_JOB_INVALID", "REVIEWED_EMPLOYMENT_JOB_SERVICE_PROOF_INVALID",
    "REVIEWED_EMPLOYMENT_JOB_AUTHORITY_UNAVAILABLE", "REVIEWED_EMPLOYMENT_JOB_CONFLICT", "REVIEWED_EMPLOYMENT_JOB_ADMISSION_UNAVAILABLE"])("keeps a known rejected %s submission closed without an uncertainty marker", async code => {
    mocks.fetchAuthMutation.mockRejectedValue(new Error(`${code} PRIVATE rejected detail`));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "We couldn't process your request. Please try again." });
    expect(names()).toEqual(["reviewedEmploymentJobs:submit"]); expect(mocks.after).not.toHaveBeenCalled();
  });

  it("does not mark a signing failure before a native submission as uncertain", async () => {
    vi.stubEnv("TELEMETRY_INGEST_SECRET", undefined);
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "We couldn't process your request. Please try again." });
    expect(names()).toEqual([]); expect(mocks.after).not.toHaveBeenCalled();
  });
});
