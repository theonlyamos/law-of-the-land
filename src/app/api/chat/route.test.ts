import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  fetchAuthMutation: vi.fn(),
  fetchAuthQuery: vi.fn(),
  isAuthenticated: vi.fn(),
}));
const aiMocks = vi.hoisted(() => ({ sendMessage: vi.fn(), sendMessageStream: vi.fn(), create: vi.fn() }));

vi.mock("@/lib/auth-server", () => authMocks);
vi.mock("server-only", () => ({}));
vi.mock("@google/genai", () => ({
  Type: { OBJECT: "OBJECT", STRING: "STRING", ARRAY: "ARRAY" },
  GoogleGenAI: class {
    chats = {
      create: aiMocks.create,
    };
  },
}));

import { POST } from "./route";
import { digestExactContext } from "@/lib/research-limits";
import { E2E_JURISDICTION_QUESTIONS } from "../../../../shared/e2e-jurisdiction-provider-contract";

const token = "a".repeat(43);
const claimNonce = "b".repeat(43);
const citationClaim = "c".repeat(43);
const CHAT_STUB_CASES = [
  ["complete", E2E_JURISDICTION_QUESTIONS.complete, "Isolated Accra complete legal answer."],
  [
    "supplementary_failure",
    E2E_JURISDICTION_QUESTIONS.supplementary_failure,
    "Isolated Accra supplementary failure legal answer.",
  ],
  [
    "selected_failure",
    E2E_JURISDICTION_QUESTIONS.selected_failure,
    "Isolated Accra selected failure legal answer.",
  ],
] as const;
const E2E_BOUNDARY_KEYS = [
  "ADMIN_E2E_FIXTURE_MODE",
  "ADMIN_E2E_TARGET_ENV",
  "ADMIN_E2E_ISOLATED_TARGET_MARKER",
  "ADMIN_E2E_PROVIDER_STUB_MODE",
  "ADMIN_E2E_CONVEX_URL",
  "ADMIN_E2E_CONVEX_SITE_URL",
  "ADMIN_E2E_APPROVED_COMMIT_SHA",
  "ADMIN_E2E_LOCAL_HEAD_SHA",
  "ADMIN_E2E_PROVIDER_OBSERVATION_SECRET",
] as const;

function enableStubBoundary() {
  const sha = "a".repeat(40);
  Object.assign(process.env, {
    ADMIN_E2E_FIXTURE_MODE: "true",
    ADMIN_E2E_TARGET_ENV: "test",
    ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e",
    ADMIN_E2E_PROVIDER_STUB_MODE: "true",
    ADMIN_E2E_CONVEX_URL: "http://127.0.0.1:3210",
    ADMIN_E2E_CONVEX_SITE_URL: "http://127.0.0.1:3211",
    ADMIN_E2E_APPROVED_COMMIT_SHA: sha,
    ADMIN_E2E_LOCAL_HEAD_SHA: sha,
    ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: "c3R1Yi1vYnNlcnZhdGlvbi1zZWNyZXQtMzItYnl0ZXM",
  });
}

function request(overrides: Record<string, unknown> = {}, accept?: string, signal?: AbortSignal) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": crypto.randomUUID(),
      ...(accept ? { accept } : {}),
    },
    body: JSON.stringify({
      query: "What is the rule?",
      messages: [],
      context: "Section 1 says the rule applies.",
      correlationToken: token,
      country: "GH",
      ...overrides,
    }),
    signal,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of E2E_BOUNDARY_KEYS) delete process.env[key];
  process.env.TELEMETRY_INGEST_SECRET = "route-test-secret-with-at-least-32-characters";
  authMocks.isAuthenticated.mockResolvedValue(true);
  authMocks.fetchAuthQuery.mockImplementation(async (reference) =>
    getFunctionName(reference) === "jurisdictions:isUnifiedJurisdictionsEnabled"
      ? false
      : { allowed: true },
  );
  authMocks.fetchAuthMutation.mockImplementation(async (reference) => {
    if (getFunctionName(reference) === "telemetry:claimChatPhase") {
      return { status: "chat_claimed", correlationId: "safe-hash", claimNonce, expiresAt: Date.now() + 60_000 };
    }
    if (getFunctionName(reference) === "chats:issueCitationClaim") {
      return { citationClaim, expiresAt: Date.now() + 60_000 };
    }
    return { status: "finalized", correlationId: "safe-hash" };
  });
  aiMocks.create.mockReturnValue({
    sendMessage: aiMocks.sendMessage,
    sendMessageStream: aiMocks.sendMessageStream,
  });
  aiMocks.sendMessage.mockResolvedValue({ text: "The generated answer." });
});

describe("POST /api/chat telemetry correlation", () => {
  it("streams model text before the terminal result metadata", async () => {
    aiMocks.sendMessageStream.mockResolvedValue((async function* () {
      yield { text: "The generated " };
      yield { text: "answer." };
    })());

    const response = await POST(request({}, "application/x-ndjson"));
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(events).toEqual([
      { type: "delta", text: "The generated " },
      { type: "delta", text: "answer." },
      { type: "done", result: "The generated answer." },
    ]);
    expect(aiMocks.sendMessage).not.toHaveBeenCalled();
    expect(authMocks.fetchAuthMutation.mock.calls.map(([reference]) => getFunctionName(reference))).toEqual([
      "telemetry:claimChatPhase",
      "telemetry:finalizeChatPhase",
    ]);
  });

  it("passes request cancellation into the model stream", async () => {
    const controller = new AbortController();
    aiMocks.sendMessageStream.mockResolvedValue((async function* () {
      yield { text: "The generated answer." };
    })());

    const streamingRequest = request({}, "application/x-ndjson", controller.signal);
    const response = await POST(streamingRequest);
    await response.text();

    const [{ config }] = aiMocks.sendMessageStream.mock.calls[0];
    expect(config.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("stops a streamed response and finalizes failure after cancellation", async () => {
    const controller = new AbortController();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let signalListenerReady!: () => void;
    const listeningForAbort = new Promise<void>((resolve) => { signalListenerReady = resolve; });
    aiMocks.sendMessageStream.mockImplementation(({ config }) => (async function* () {
      yield { text: "The generated " };
      await new Promise<never>((_, reject) => {
        config.abortSignal.addEventListener("abort", () => reject(new Error("stream aborted")), { once: true });
        signalListenerReady();
      });
    })());

    const response = await POST(request({}, "application/x-ndjson", controller.signal));
    const reader = response.body!.getReader();
    expect(JSON.parse(new TextDecoder().decode((await reader.read()).value))).toEqual({
      type: "delta",
      text: "The generated ",
    });
    await listeningForAbort;
    controller.abort();

    await expect(Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stream did not close")), 50)),
    ])).resolves.toMatchObject({ done: true });
    expect(authMocks.fetchAuthMutation.mock.calls.at(-1)?.[1]).toMatchObject({ providerStatus: "failure" });
    expect(errorLog).not.toHaveBeenCalledWith("Chat provider request failed");
    errorLog.mockRestore();
  });

  it("ends a streamed response when the provider fails", async () => {
    aiMocks.sendMessageStream.mockRejectedValue(new Error("provider unavailable"));
    const response = await POST(request({}, "application/x-ndjson"));
    const body = await Promise.race([
      response.text(),
      new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error("stream did not close")), 50);
      }),
    ]);

    expect(JSON.parse(body.trim())).toEqual({ type: "error", error: "We couldn't process your request. Please try again." });
  });

  it("claims the bound search exactly once and finalizes only compact provider timing", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: "The generated answer." });
    expect(authMocks.fetchAuthMutation.mock.calls.map(([reference]) => getFunctionName(reference))).toEqual([
      "telemetry:claimChatPhase",
      "telemetry:finalizeChatPhase",
    ]);
    expect(authMocks.fetchAuthMutation.mock.calls[0][1]).toMatchObject({
      token,
      jurisdictionCode: "GH",
      serviceProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(authMocks.fetchAuthMutation.mock.calls[1][1]).toMatchObject({
      token,
      claimNonce,
      providerStatus: "success",
      latencyMs: expect.any(Number),
      serviceProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    const telemetryPayload = JSON.stringify(authMocks.fetchAuthMutation.mock.calls);
    for (const forbidden of ["What is the rule?", "Section 1", "generated answer"]) {
      expect(telemetryPayload).not.toContain(forbidden);
    }
    expect(aiMocks.create.mock.calls[0][0].config.tools).toEqual([{ googleSearch: {} }]);
  });

  it.each([
    ["missing token", { correlationToken: undefined }],
    ["forged token", { correlationToken: "client-chosen" }],
    ["missing jurisdiction", { country: undefined }],
  ])("rejects %s before claiming or calling Gemini", async (_label, body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(aiMocks.sendMessage).not.toHaveBeenCalled();
  });

  it("does not call Gemini when the owner, session, expiry, replay, or jurisdiction claim fails", async () => {
    authMocks.fetchAuthMutation.mockRejectedValue(new Error("TELEMETRY_CORRELATION_FORBIDDEN"));
    const response = await POST(request());
    expect(response.status).toBe(400);
    expect(aiMocks.sendMessage).not.toHaveBeenCalled();
  });

  it("terminalizes provider failure once without copying its raw error into telemetry or logs", async () => {
    aiMocks.sendMessage.mockRejectedValue(new Error("provider-key-secret-value"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(authMocks.fetchAuthMutation.mock.calls.map(([reference]) => getFunctionName(reference))).toEqual([
      "telemetry:claimChatPhase",
      "telemetry:finalizeChatPhase",
    ]);
    expect(authMocks.fetchAuthMutation.mock.calls[1][1]).toMatchObject({ providerStatus: "failure" });
    expect(authMocks.fetchAuthMutation.mock.calls[1][1]).not.toHaveProperty("error");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("provider-key-secret-value");
    errorLog.mockRestore();
  });

  it("does not rewrite a successful Gemini outcome as provider failure when finalization delivery fails", async () => {
    authMocks.fetchAuthMutation.mockImplementation(async (reference) => {
      if (getFunctionName(reference) === "telemetry:claimChatPhase") return { claimNonce };
      throw new Error("telemetry transport unavailable");
    });
    const response = await POST(request());
    expect(response.status).toBe(500);
    const finalizeCalls = authMocks.fetchAuthMutation.mock.calls.filter(([reference]) => getFunctionName(reference) === "telemetry:finalizeChatPhase");
    expect(finalizeCalls).toHaveLength(1);
    expect(finalizeCalls[0][1]).toMatchObject({ providerStatus: "success" });
  });
});

describe("POST /api/chat governed citations", () => {
  const jurisdictionId = "selected-jurisdiction-id";
  const context = JSON.stringify({
    version: 1,
    sources: [{
      sourceRef: "J1",
      jurisdictionId,
      name: "Ghana",
      kind: "geographic",
      relation: "selected",
      content: "Section 1 says the rule applies.",
    }],
  });

  beforeEach(() => {
    authMocks.fetchAuthQuery.mockImplementation(async (reference) =>
      getFunctionName(reference) === "jurisdictions:isUnifiedJurisdictionsEnabled"
        ? true
        : { allowed: true },
    );
    aiMocks.sendMessage.mockResolvedValue({
      text: JSON.stringify({ answer: "The governed answer.", citations: [{ sourceRef: "J1", label: "Section 1" }] }),
    });
  });

  const governedRequest = (overrides: Record<string, unknown> = {}, accept?: string) => request({
    context,
    jurisdictionId,
    externalId: "claim-chat",
    assistantClientId: "assistant-client-1",
    ...overrides,
  }, accept);

  it("streams only governed answer text before verified citations arrive", async () => {
    aiMocks.sendMessageStream.mockResolvedValue((async function* () {
      yield { text: '{"answer":"The governed ' };
      yield { text: 'answer.","citations":[{"sourceRef":"J1","label":"Section 1"}]}' };
    })());

    const response = await POST(governedRequest({}, "application/x-ndjson"));
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events).toEqual([
      { type: "delta", text: "The governed " },
      { type: "delta", text: "answer." },
      {
        type: "done",
        result: "The governed answer.",
        citations: [{
          label: "Section 1",
          jurisdictionId,
          jurisdictionName: "Ghana",
          jurisdictionKind: "geographic",
          relation: "selected",
        }],
        citationClaim,
      },
    ]);
    expect(aiMocks.sendMessage).not.toHaveBeenCalled();
  });

  it("streams a governed answer when citations precede the answer property", async () => {
    aiMocks.sendMessageStream.mockResolvedValue((async function* () {
      yield { text: '{"citations":[{"sourceRef":"J1","label":"Section 1"}],"answer":"The governed ' };
      yield { text: 'answer."}' };
    })());

    const response = await POST(governedRequest({}, "application/x-ndjson"));
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events).toEqual([
      { type: "delta", text: "The governed " },
      { type: "delta", text: "answer." },
      expect.objectContaining({ type: "done", result: "The governed answer." }),
    ]);
  });

  it("claims the exact context digest before Gemini and resolves model refs through governed metadata", async () => {
    const response = await POST(governedRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      result: "The governed answer.",
      citations: [{
        label: "Section 1",
        jurisdictionId,
        jurisdictionName: "Ghana",
        jurisdictionKind: "geographic",
        relation: "selected",
      }],
      citationClaim,
    });
    const claimArgs = authMocks.fetchAuthMutation.mock.calls[0][1];
    expect(claimArgs).toMatchObject({
      jurisdictionId,
      legacyCountryCode: "GH",
      contextDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(aiMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: expect.any(Object),
      }),
    }));
    expect(aiMocks.create.mock.calls[0][0].config.tools).toBeUndefined();
    expect(authMocks.fetchAuthMutation.mock.calls.map(([reference]) => getFunctionName(reference))).toEqual([
      "telemetry:claimChatPhase",
      "chats:issueCitationClaim",
      "telemetry:finalizeChatPhase",
    ]);
    expect(authMocks.fetchAuthMutation.mock.calls[1][1]).toMatchObject({
      externalId: "claim-chat",
      jurisdictionId,
      assistantClientId: "assistant-client-1",
      assistantContent: "The governed answer.",
      citations: payload.citations,
      assistantClientIdBinding: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      assistantContentBinding: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      orderedCitationBinding: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      serviceProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    const telemetryCalls = authMocks.fetchAuthMutation.mock.calls.filter(([reference]) =>
      getFunctionName(reference).startsWith("telemetry:"));
    expect(JSON.stringify(telemetryCalls)).not.toMatch(/The governed answer|Section 1|assistant-client-1/);
  });

  it.each(CHAT_STUB_CASES)(
    "resolves the exact %s stub J1 through server context and persists the real citation claim",
    async (_scenario, question, expectedAnswer) => {
      enableStubBoundary();

      const response = await POST(governedRequest({ query: question }));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload).toEqual({
        result: expectedAnswer,
        citations: [{
          label: "Isolated Accra legal evidence",
          jurisdictionId,
          jurisdictionName: "Ghana",
          jurisdictionKind: "geographic",
          relation: "selected",
        }],
        citationClaim,
      });
      expect(aiMocks.create).not.toHaveBeenCalled();
      expect(aiMocks.sendMessage).not.toHaveBeenCalled();
      expect(authMocks.fetchAuthMutation.mock.calls.map(([reference]) => getFunctionName(reference)))
        .toEqual([
          "telemetry:claimChatPhase",
          "chats:issueCitationClaim",
          "telemetry:finalizeChatPhase",
        ]);
      expect(authMocks.fetchAuthMutation.mock.calls[1][1]).toMatchObject({
        jurisdictionId,
        assistantContent: payload.result,
        citations: payload.citations,
      });
    },
  );

  it("fails an inexact stub question after digest claim and before model construction", async () => {
    enableStubBoundary();

    const response = await POST(governedRequest({
      query: `${E2E_JURISDICTION_QUESTIONS.complete} `,
    }));

    expect(response.status).toBe(500);
    expect(aiMocks.create).not.toHaveBeenCalled();
    expect(aiMocks.sendMessage).not.toHaveBeenCalled();
    expect(authMocks.fetchAuthMutation.mock.calls.map(([reference]) => getFunctionName(reference)))
      .toEqual(["telemetry:claimChatPhase", "telemetry:finalizeChatPhase"]);
    expect(authMocks.fetchAuthMutation.mock.calls[1][1]).toMatchObject({ providerStatus: "failure" });
  });

  it("rejects an unknown source ref, finalizes exactly one failure, and exposes no model provenance", async () => {
    aiMocks.sendMessage.mockResolvedValue({
      text: JSON.stringify({
        answer: "Unsafe answer",
        citations: [{ sourceRef: "J4", label: "https://provider.example/private" }],
      }),
    });
    const response = await POST(governedRequest());
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(JSON.stringify(payload)).not.toContain("provider.example");
    expect(authMocks.fetchAuthMutation.mock.calls.map(([reference]) => getFunctionName(reference)))
      .toEqual(["telemetry:claimChatPhase", "telemetry:finalizeChatPhase"]);
    expect(authMocks.fetchAuthMutation.mock.calls[1][1]).toMatchObject({ providerStatus: "failure" });
  });

  it("rejects oversized exact context before telemetry claim or Gemini", async () => {
    const response = await POST(governedRequest({ context: "x".repeat(120_001) }));
    expect(response.status).toBe(400);
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(aiMocks.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects a lone-surrogate context digest that differs from replacement-character context before Gemini", async () => {
    const replacementContext = context.replace("Section 1 says the rule applies.", "\uFFFD");
    const loneSurrogateContext = context.replace("Section 1 says the rule applies.", "\uD800");
    const replacementDigest = await digestExactContext(replacementContext);
    const loneSurrogateDigest = await digestExactContext(loneSurrogateContext);
    expect(loneSurrogateDigest).not.toBe(replacementDigest);
    authMocks.fetchAuthMutation.mockImplementation(async (reference, args) => {
      if (getFunctionName(reference) === "telemetry:claimChatPhase") {
        expect(args.contextDigest).toBe(loneSurrogateDigest);
        throw new Error("TELEMETRY_CONTEXT_MISMATCH");
      }
      return { status: "finalized", correlationId: "safe-hash" };
    });

    const response = await POST(governedRequest({ context: loneSurrogateContext }));

    expect(response.status).toBe(400);
    expect(aiMocks.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "not-json"],
    ["extra answer key", JSON.stringify({ answer: "Answer", citations: [], provenance: "model" })],
    ["duplicate citation pair", JSON.stringify({
      answer: "Answer",
      citations: [
        { sourceRef: "J1", label: "Section 1" },
        { sourceRef: "J1", label: "Section 1" },
      ],
    })],
  ])("fails closed on %s and records one terminal failure", async (_label, text) => {
    aiMocks.sendMessage.mockResolvedValue({ text });
    const response = await POST(governedRequest());
    expect(response.status).toBe(500);
    expect(authMocks.fetchAuthMutation.mock.calls.map(([reference]) => getFunctionName(reference)))
      .toEqual(["telemetry:claimChatPhase", "telemetry:finalizeChatPhase"]);
    expect(authMocks.fetchAuthMutation.mock.calls[1][1]).toMatchObject({ providerStatus: "failure" });
  });

  it.each([
    ["missing chat id", { externalId: undefined }],
    ["oversized chat id", { externalId: "x".repeat(201) }],
    ["missing assistant client id", { assistantClientId: undefined }],
    ["oversized assistant client id", { assistantClientId: "x".repeat(201) }],
  ])("rejects %s before claiming or calling Gemini", async (_label, overrides) => {
    const response = await POST(governedRequest(overrides));
    expect(response.status).toBe(400);
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(aiMocks.sendMessage).not.toHaveBeenCalled();
  });

  it("finalizes a provider success but returns no answer when citation claim issuance fails", async () => {
    authMocks.fetchAuthMutation.mockImplementation(async (reference) => {
      const name = getFunctionName(reference);
      if (name === "telemetry:claimChatPhase") return { claimNonce };
      if (name === "chats:issueCitationClaim") throw new Error("claim store unavailable");
      return { status: "finalized", correlationId: "safe-hash" };
    });
    const response = await POST(governedRequest());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "We couldn't process your request. Please try again." });
    expect(authMocks.fetchAuthMutation.mock.calls.map(([reference]) => getFunctionName(reference))).toEqual([
      "telemetry:claimChatPhase",
      "chats:issueCitationClaim",
      "telemetry:finalizeChatPhase",
    ]);
    expect(authMocks.fetchAuthMutation.mock.calls[2][1]).toMatchObject({ providerStatus: "success" });
  });
});
