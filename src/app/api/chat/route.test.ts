import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  fetchAuthMutation: vi.fn(),
  fetchAuthQuery: vi.fn(),
  getToken: vi.fn(),
  isAuthenticated: vi.fn(),
}));
const rateLimitMocks = vi.hoisted(() => ({ rateLimit: vi.fn() }));
const interactionMocks = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn() }));

vi.mock("@/lib/auth-server", () => authMocks);
vi.mock("@/lib/rate-limit", () => ({
  clientKey: () => "route-test-client",
  rateLimit: rateLimitMocks.rateLimit,
}));
vi.mock("server-only", () => ({}));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    interactions = interactionMocks;
  },
}));

import { POST, maxDuration } from "./route";

const selectedJurisdictionId = "selected-jurisdiction-id";
const selectedResourceId = "selected-resource-id";
const selectedVersionId = "selected-version-id";
const selectedStoreName = "fileSearchStores/ghana";
const citationClaim = "c".repeat(43);

type PublicCitation = {
  label: string;
  jurisdictionId: string;
  jurisdictionName: string;
  jurisdictionKind: "geographic" | "organizational";
  relation: "selected" | "geographic_ancestor" | "organizational_geography";
};

const manifest = {
  authorizedScopeSize: 1,
  stores: [{
    jurisdictionId: selectedJurisdictionId,
    name: "Ghana",
    kind: "geographic" as const,
    relation: "selected" as const,
    storeName: "fileSearchStores/ghana",
  }],
  partialCoverage: false,
};

const publicCitation: PublicCitation = {
  label: "Labour Act, 2003, page 12",
  jurisdictionId: selectedJurisdictionId,
  jurisdictionName: "Ghana",
  jurisdictionKind: "geographic",
  relation: "selected",
};

function request(
  overrides: Record<string, unknown> = {},
  options: { signal?: AbortSignal; body?: string; contentLength?: string } = {},
) {
  const body = options.body ?? JSON.stringify({
    query: "What protection applies?",
    jurisdictionId: selectedJurisdictionId,
    messages: [],
    externalId: "chat-external-id",
    assistantClientId: "assistant-client-id",
    ...overrides,
  });
  const headers = new Headers({
    accept: "application/x-ndjson",
    "content-type": "application/json",
    "x-forwarded-for": crypto.randomUUID(),
  });
  if (options.contentLength !== undefined) headers.set("content-length", options.contentLength);
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers,
    body,
    signal: options.signal,
  });
}

function successfulStream(answer = "Employees are protected.") {
  return (async function* () {
    yield {
      event_type: "interaction.created",
      interaction: { id: "interaction-1", status: "in_progress" },
    };
    yield {
      event_type: "step.start",
      interaction_id: "interaction-1",
      index: 0,
      step: { type: "file_search_call", id: "search-call-1" },
    };
    yield { event_type: "step.stop", interaction_id: "interaction-1", index: 0 };
    yield {
      event_type: "step.start",
      interaction_id: "interaction-1",
      index: 1,
      step: { type: "file_search_result", call_id: "search-call-1" },
    };
    yield { event_type: "step.stop", interaction_id: "interaction-1", index: 1 };
    yield {
      event_type: "step.start",
      interaction_id: "interaction-1",
      index: 2,
      step: { type: "model_output" },
    };
    yield {
      event_type: "step.delta",
      interaction_id: "interaction-1",
      index: 2,
      delta: { type: "text", text: answer.slice(0, 10) },
    };
    yield {
      event_type: "step.delta",
      interaction_id: "interaction-1",
      index: 2,
      delta: { type: "text", text: answer.slice(10) },
    };
    yield { event_type: "step.stop", interaction_id: "interaction-1", index: 2 };
    yield {
      event_type: "interaction.completed",
      interaction: { id: "interaction-1", status: "completed" },
    };
  })();
}

function canonicalInteraction(
  answer = "Employees are protected.",
  citationJurisdictionId = selectedJurisdictionId,
) {
  return {
    id: "interaction-1",
    status: "completed",
    steps: [{
      type: "model_output",
      content: [{
        type: "text",
        text: answer,
        annotations: [{
          type: "file_citation",
          document_uri: selectedStoreName,
          custom_metadata: {
            jurisdiction_id: citationJurisdictionId,
            resource_id: selectedResourceId,
            version_id: selectedVersionId,
          },
          page_number: 12,
        }],
      }],
    }],
    usage: { total_input_tokens: 20, total_output_tokens: 8, total_tokens: 28 },
  };
}

async function events(response: Response) {
  const body = await response.text();
  return body.trim() ? body.trim().split("\n").map((line) => JSON.parse(line)) : [];
}

function mutationNames() {
  return authMocks.fetchAuthMutation.mock.calls.map(([reference]) => getFunctionName(reference));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_AI_API_KEY = "test-google-key";
  process.env.GOOGLE_AI_MODEL = "gemini-test-model";
  process.env.NEXT_PUBLIC_CONVEX_SITE_URL = "https://convex.example.test";
  process.env.TELEMETRY_INGEST_SECRET = "route-test-secret-with-at-least-32-characters";
  authMocks.isAuthenticated.mockResolvedValue(true);
  authMocks.getToken.mockResolvedValue("user-session-token");
  authMocks.fetchAuthQuery.mockResolvedValue({
    allowed: true,
    canRecord: true,
    used: 0,
    limit: 10,
    isPro: false,
  });
  authMocks.fetchAuthMutation.mockImplementation(async (reference) => {
    const name = getFunctionName(reference);
    if (name === "usage:recordQuestion") return { used: 1, limit: 10, isPro: false };
    if (name === "chats:completeGovernedInteraction") {
      return {
        status: "completed",
        outcome: "success",
        citations: [publicCitation],
        partialCoverage: false,
        citationClaim,
        expiresAt: Date.now() + 60_000,
      };
    }
    throw new Error(`Unexpected mutation: ${name}`);
  });
  rateLimitMocks.rateLimit.mockReturnValue({ ok: true, retryAfterSeconds: 0 });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(manifest)));
  interactionMocks.create.mockResolvedValue(successfulStream());
  interactionMocks.get.mockResolvedValue(canonicalInteraction());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.GOOGLE_AI_API_KEY;
  delete process.env.GOOGLE_AI_MODEL;
  delete process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  delete process.env.TELEMETRY_INGEST_SECRET;
});

describe("POST /api/chat request boundary", () => {
  it("bounds a stalled authentication preflight by the shared model cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
    let releaseAuthentication!: (authenticated: boolean) => void;
    authMocks.isAuthenticated.mockReturnValue(new Promise((resolve) => {
      releaseAuthentication = resolve;
    }));

    const responsePromise = POST(request());
    await vi.advanceTimersByTimeAsync(90_000);
    let response: Response | null = null;
    try {
      response = await Promise.race([responsePromise, Promise.resolve(null)]);
      expect(response).not.toBeNull();
      expect(response?.status).toBe(500);
    } finally {
      if (!response) {
        releaseAuthentication(true);
        await responsePromise;
      }
    }
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it("cancels and bounds a stalled request body read by the shared model cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const cancelBody = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        controller.enqueue(new TextEncoder().encode('{"query":'));
      },
      cancel: cancelBody,
    });
    const stalledRequest = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: {
        accept: "application/x-ndjson",
        "content-type": "application/json",
        "x-forwarded-for": crypto.randomUUID(),
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const responsePromise = POST(stalledRequest);
    await vi.advanceTimersByTimeAsync(90_000);
    let response: Response | null = null;
    try {
      response = await Promise.race([responsePromise, Promise.resolve(null)]);
      expect(response).not.toBeNull();
      expect(response?.status).toBe(500);
      expect(cancelBody).toHaveBeenCalledTimes(1);
    } finally {
      if (!response) {
        bodyController.close();
        await responsePromise;
      }
    }
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests before reading or charging them", async () => {
    authMocks.isAuthenticated.mockResolvedValue(false);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(authMocks.getToken).not.toHaveBeenCalled();
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it("enforces the route rate limit before provider work", async () => {
    rateLimitMocks.rateLimit.mockReturnValue({ ok: false, retryAfterSeconds: 17 });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(authMocks.getToken).not.toHaveBeenCalled();
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it.each([
    ["context", "untrusted context"],
    ["country", "GH"],
    ["legacyCountryCode", "GH"],
    ["stores", [{ storeName: "fileSearchStores/forged" }]],
    ["supplementaryStores", ["fileSearchStores/forged"]],
    ["arbitrary", true],
  ])("rejects the removed or arbitrary %s field", async (key, value) => {
    const response = await POST(request({ [key]: value }));

    expect(response.status).toBe(400);
    expect(authMocks.getToken).not.toHaveBeenCalled();
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it.each([
    ["missing query", { query: undefined }],
    ["empty query", { query: "   " }],
    ["oversized query", { query: "q".repeat(4_001) }],
    ["missing jurisdiction", { jurisdictionId: undefined }],
    ["missing messages", { messages: undefined }],
    ["too many messages", { messages: Array.from({ length: 21 }, () => ({ role: "user", content: "x" })) }],
    ["invalid message role", { messages: [{ role: "system", content: "x" }] }],
    ["oversized message", { messages: [{ role: "user", content: "x".repeat(16_001) }] }],
    ["missing chat ID", { externalId: undefined }],
    ["oversized chat ID", { externalId: "x".repeat(201) }],
    ["missing assistant ID", { assistantClientId: undefined }],
    ["oversized assistant ID", { assistantClientId: "x".repeat(201) }],
  ])("rejects %s before provider work", async (_label, overrides) => {
    const response = await POST(request(overrides));

    expect(response.status).toBe(400);
    expect(authMocks.getToken).not.toHaveBeenCalled();
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it("rejects an oversized raw body without calling Request.json", async () => {
    const oversized = request({}, { body: `{"padding":"${"x".repeat(400_000)}"}` });
    const jsonSpy = vi.spyOn(oversized, "json").mockRejectedValue(new Error("Request.json must not run"));

    const response = await POST(oversized);

    expect(response.status).toBe(400);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(authMocks.getToken).not.toHaveBeenCalled();
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it("rejects quota exhaustion before resolving provider stores", async () => {
    authMocks.fetchAuthQuery.mockResolvedValue({
      allowed: false,
      canRecord: false,
      used: 10,
      limit: 10,
      isPro: false,
    });

    const response = await POST(request());

    expect(response.status).toBe(402);
    expect(authMocks.getToken).not.toHaveBeenCalled();
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it.each([404, 503])("fails a private manifest preflight with no charge for HTTP %s", async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status }));

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "That jurisdiction is not available for research." });
    expect(fetch).toHaveBeenCalledWith(
      "https://convex.example.test/private/chat-research-manifest",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer user-session-token" }),
        body: JSON.stringify({ jurisdictionId: selectedJurisdictionId }),
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it("rejects malformed private manifest data instead of accepting forged stores", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({
      ...manifest,
      stores: [{ ...manifest.stores[0], relation: "geographic_ancestor" }],
    }));

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat streamed governed interaction", () => {
  it("reserves hosting time beyond the application deadline", () => {
    expect(maxDuration).toBeGreaterThan(110);
  });

  it("completes an uncited greeting as a claimed no-evidence answer", async () => {
    interactionMocks.create.mockResolvedValue(successfulStream("Hello!"));
    const final = canonicalInteraction("Hello!");
    final.steps[0].content[0].annotations = [];
    interactionMocks.get.mockResolvedValue(final);
    authMocks.fetchAuthMutation.mockImplementation(async (reference) => {
      if (getFunctionName(reference) === "usage:recordQuestion") return {};
      return { status: "completed", outcome: "success", citations: [], partialCoverage: false,
        citationClaim, expiresAt: Date.now() + 60_000 };
    });
    const result = await events(await POST(request({ query: "hello" })));
    expect(result.at(-1)).toMatchObject({ type: "done", citations: [], citationClaim,
      result: "I couldn't find enough supporting material in this jurisdiction's library to answer. Try asking a more specific legal question." });
  });

  it("closes at the application deadline even when the canonical read ignores cancellation", async () => {
    vi.useFakeTimers();
    interactionMocks.get.mockImplementation(() => new Promise(() => undefined));
    const resultPromise = events(await POST(request()));
    await vi.advanceTimersByTimeAsync(110_000);
    expect((await resultPromise).at(-1)?.type).toBe("error");
  });

  it("uses one selected-first File Search interaction and terminalizes before done", async () => {
    let finishTerminal!: (value: unknown) => void;
    const terminal = new Promise((resolve) => { finishTerminal = resolve; });
    authMocks.fetchAuthMutation.mockImplementation(async (reference) => {
      const name = getFunctionName(reference);
      if (name === "usage:recordQuestion") return { used: 1, limit: 10, isPro: false };
      if (name === "chats:completeGovernedInteraction") return await terminal;
      throw new Error(`Unexpected mutation: ${name}`);
    });

    const response = await POST(request());
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = JSON.parse(decoder.decode((await reader.read()).value).trim());
    const second = JSON.parse(decoder.decode((await reader.read()).value).trim());

    expect(first).toEqual({ type: "delta", text: "Employees " });
    expect(second).toEqual({ type: "delta", text: "are protected." });
    expect(interactionMocks.create).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(interactionMocks.get).toHaveBeenCalledTimes(1);
      expect(mutationNames()).toEqual(["usage:recordQuestion", "chats:completeGovernedInteraction"]);
    });
    expect(interactionMocks.create.mock.calls[0][0]).toMatchObject({
      model: "gemini-test-model",
      stream: true,
      tools: [{ type: "file_search", file_search_store_names: ["fileSearchStores/ghana"] }],
    });

    finishTerminal({
      status: "completed",
      outcome: "success",
      citations: [publicCitation],
      partialCoverage: false,
      citationClaim,
      expiresAt: Date.now() + 60_000,
    });
    const terminalEvent = JSON.parse(decoder.decode((await reader.read()).value).trim());
    expect(terminalEvent).toEqual({
      type: "done",
      result: "Employees are protected.",
      citations: [publicCitation],
      citationClaim,
      partialCoverage: false,
    });
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("passes only the exact request history and server manifest to Gemini", async () => {
    const history = [
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
    ];

    await events(await POST(request({ messages: history })));

    const providerInput = JSON.parse(interactionMocks.create.mock.calls[0][0].input.text);
    expect(providerInput).toEqual({
      untrustedQuestion: "What protection applies?",
      conversation: history,
    });
    expect(JSON.stringify(interactionMocks.create.mock.calls[0][0])).not.toContain("user-session-token");
  });

  it("binds canonical citations and server-derived scope metadata in the terminal mutation", async () => {
    await events(await POST(request()));

    const terminalArgs = authMocks.fetchAuthMutation.mock.calls.find(
      ([reference]) => getFunctionName(reference) === "chats:completeGovernedInteraction",
    )?.[1];
    expect(terminalArgs).toMatchObject({
      routeNonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      externalId: "chat-external-id",
      jurisdictionId: selectedJurisdictionId,
      assistantClientId: "assistant-client-id",
      finalAnswer: "Employees are protected.",
      citations: [{
        jurisdictionId: selectedJurisdictionId,
        resourceId: selectedResourceId,
        versionId: selectedVersionId,
        providerStoreName: selectedStoreName,
        pageNumber: 12,
      }],
      model: "gemini-test-model",
      elapsedMs: expect.any(Number),
      outcome: "success",
      authorizedScopeSize: 1,
      readyStoreCount: 1,
      partialCoverage: false,
      jurisdictionCoverage: [{ ordinal: 0, relation: "selected", coverage: "evidence" }],
      serviceProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(terminalArgs).not.toHaveProperty("error");
  });

  it("rejects a document URI instead of treating it as a store identity", async () => {
    const documentName = "fileSearchStores/ghana/documents/wrong-document";
    const canonical = canonicalInteraction();
    canonical.steps[0].content[0].annotations[0].document_uri = documentName;
    interactionMocks.get.mockResolvedValue(canonical);

    const streamEvents = await events(await POST(request()));

    expect(streamEvents.at(-1)).toEqual({
      type: "error",
      error: "We couldn't process your request. Please try again.",
    });
    expect(streamEvents.some((event) => event.type === "done")).toBe(false);
    expect(JSON.stringify(streamEvents)).not.toContain(documentName);
  });

  it("rejects a result without a selected-store citation and emits no done", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({
      authorizedScopeSize: 2,
      stores: [
        manifest.stores[0],
        {
          jurisdictionId: "parent-jurisdiction-id",
          name: "West Africa",
          kind: "geographic",
          relation: "geographic_ancestor",
          storeName: "fileSearchStores/west-africa",
        },
      ],
      partialCoverage: false,
    }));
    interactionMocks.get.mockResolvedValue(canonicalInteraction(
      "Employees are protected.",
      "parent-jurisdiction-id",
    ));

    const streamEvents = await events(await POST(request()));

    expect(streamEvents.at(-1)).toEqual({
      type: "error",
      error: "We couldn't process your request. Please try again.",
    });
    expect(streamEvents.some((event) => event.type === "done")).toBe(false);
    const failure = authMocks.fetchAuthMutation.mock.calls.find(
      ([reference, args]) => getFunctionName(reference) === "chats:completeGovernedInteraction" && args.outcome === "failure",
    )?.[1];
    expect(failure).toMatchObject({ failureCategory: "validation", citations: [] });
    expect(failure).not.toHaveProperty("finalAnswer");
  });

  it("never emits a raw Gemini error or done after provider failure", async () => {
    const rawSecret = "provider-key-and-file-search-store-secret";
    interactionMocks.create.mockRejectedValue(Object.assign(new Error(rawSecret), { status: 403 }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const streamEvents = await events(await POST(request()));

    expect(streamEvents).toEqual([{
      type: "error",
      error: "We couldn't process your request. Please try again.",
    }]);
    expect(JSON.stringify(streamEvents)).not.toContain(rawSecret);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(rawSecret);
    expect(errorLog).toHaveBeenCalledWith("chat_request_failed", expect.any(String));
    expect(JSON.parse(errorLog.mock.calls.at(-1)![1])).toMatchObject({
      phase: "generation", category: "authentication", elapsedMs: expect.any(Number),
    });
    expect(streamEvents.some((event) => event.type === "done")).toBe(false);
    const terminalArgs = authMocks.fetchAuthMutation.mock.calls.at(-1)?.[1];
    expect(terminalArgs).toMatchObject({
      outcome: "failure",
      failureCategory: "authentication",
      citations: [],
      jurisdictionCoverage: [{ ordinal: 0, relation: "selected", coverage: "no_evidence" }],
    });
    expect(terminalArgs).not.toHaveProperty("error");
    expect(terminalArgs).not.toHaveProperty("finalAnswer");
  });

  it("treats replayed terminal completion as no new done event", async () => {
    authMocks.fetchAuthMutation.mockImplementation(async (reference) => {
      const name = getFunctionName(reference);
      if (name === "usage:recordQuestion") return { used: 1, limit: 10, isPro: false };
      return { status: "replayed", outcome: "success" };
    });

    const streamEvents = await events(await POST(request()));

    expect(streamEvents.some((event) => event.type === "done")).toBe(false);
    expect(streamEvents.at(-1)).toEqual({
      type: "error",
      error: "We couldn't process your request. Please try again.",
    });
  });

  it("aborts the provider at the single 90-second model cutoff and remains inside the terminal window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
    let providerSignal: AbortSignal | undefined;
    interactionMocks.create.mockImplementation(async (_input, options) => {
      providerSignal = options.signal;
      return (async function* () {
        yield {
          event_type: "interaction.created",
          interaction: { id: "interaction-timeout", status: "in_progress" },
        };
        await new Promise<never>((_, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
        });
      })();
    });

    const responsePromise = POST(request());
    await vi.advanceTimersByTimeAsync(90_000);
    const streamEvents = await events(await responsePromise);

    expect(providerSignal?.aborted).toBe(true);
    expect(streamEvents.some((event) => event.type === "done")).toBe(false);
    expect(streamEvents.at(-1)).toEqual({
      type: "error",
      error: "We couldn't process your request. Please try again.",
    });
    const terminalArgs = authMocks.fetchAuthMutation.mock.calls.at(-1)?.[1];
    expect(terminalArgs).toMatchObject({
      outcome: "failure",
      failureCategory: "timeout",
      elapsedMs: 90_000,
    });
  });

  it("uses the terminal reserve for the canonical read after the stream completes near 90 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
    let streamSignal: AbortSignal | undefined;
    let canonicalSignal: AbortSignal | undefined;
    interactionMocks.create.mockImplementation(async (_input, options) => {
      streamSignal = options.signal;
      return (async function* () {
        await new Promise((resolve) => setTimeout(resolve, 89_900));
        for await (const event of successfulStream()) yield event;
      })();
    });
    interactionMocks.get.mockImplementation(async (_id, _params, options) => {
      canonicalSignal = options.signal;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(canonicalInteraction()), 1_100);
        options.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("canonical read aborted"));
        }, { once: true });
      });
    });

    const response = await POST(request());
    const streamEventsPromise = events(response);
    await vi.advanceTimersByTimeAsync(91_000);
    const streamEvents = await streamEventsPromise;

    expect(streamSignal?.aborted).toBe(false);
    expect(canonicalSignal).not.toBe(streamSignal);
    expect(canonicalSignal?.aborted).toBe(false);
    expect(streamEvents.at(-1)?.type).toBe("done");
  });

  it("emits no done when terminal validation exhausts the shared 110-second deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
    authMocks.fetchAuthMutation.mockImplementation(async (reference) => {
      const name = getFunctionName(reference);
      if (name === "usage:recordQuestion") return { used: 1, limit: 10, isPro: false };
      return await new Promise<never>(() => undefined);
    });

    const response = await POST(request());
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    expect(JSON.parse(decoder.decode((await reader.read()).value).trim()).type).toBe("delta");
    expect(JSON.parse(decoder.decode((await reader.read()).value).trim()).type).toBe("delta");
    await vi.waitFor(() => {
      expect(mutationNames()).toEqual(["usage:recordQuestion", "chats:completeGovernedInteraction"]);
    });

    await vi.advanceTimersByTimeAsync(110_000);
    const terminalEvent = JSON.parse(decoder.decode((await reader.read()).value).trim());

    expect(terminalEvent).toEqual({
      type: "error",
      error: "We couldn't process your request. Please try again.",
    });
    expect(mutationNames()).toEqual(["usage:recordQuestion", "chats:completeGovernedInteraction"]);
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("records an aborted outcome and closes without done when the client disconnects", async () => {
    const abort = new AbortController();
    interactionMocks.create.mockImplementation(async (_input, options) => (async function* () {
      yield {
        event_type: "interaction.created",
        interaction: { id: "interaction-abort", status: "in_progress" },
      };
      await new Promise<never>((_, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
      });
    })());

    const response = await POST(request({}, { signal: abort.signal }));
    abort.abort();
    const streamEvents = await events(response);

    expect(streamEvents.some((event) => event.type === "done")).toBe(false);
    expect(streamEvents.some((event) => event.type === "error")).toBe(false);
    expect(authMocks.fetchAuthMutation.mock.calls.at(-1)?.[1]).toMatchObject({
      outcome: "aborted",
      citations: [],
    });
  });
});
