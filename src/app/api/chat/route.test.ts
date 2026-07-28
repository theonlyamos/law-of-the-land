import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  fetchAuthMutation: vi.fn(),
  fetchAuthQuery: vi.fn(),
  isAuthenticated: vi.fn(),
}));
const aiMocks = vi.hoisted(() => ({ sendMessage: vi.fn() }));

vi.mock("@/lib/auth-server", () => authMocks);
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    chats = {
      create: () => ({ sendMessage: aiMocks.sendMessage }),
    };
  },
}));

import { POST } from "./route";

const token = "a".repeat(43);
const claimNonce = "b".repeat(43);

function request(overrides: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": crypto.randomUUID() },
    body: JSON.stringify({
      query: "What is the rule?",
      messages: [],
      context: "Section 1 says the rule applies.",
      correlationToken: token,
      country: "GH",
      ...overrides,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TELEMETRY_INGEST_SECRET = "route-test-secret-with-at-least-32-characters";
  authMocks.isAuthenticated.mockResolvedValue(true);
  authMocks.fetchAuthQuery.mockResolvedValue({ allowed: true });
  authMocks.fetchAuthMutation.mockImplementation(async (reference) => {
    if (getFunctionName(reference) === "telemetry:claimChatPhase") {
      return { status: "chat_claimed", correlationId: "safe-hash", claimNonce, expiresAt: Date.now() + 60_000 };
    }
    return { status: "finalized", correlationId: "safe-hash" };
  });
  aiMocks.sendMessage.mockResolvedValue({ text: "The generated answer." });
});

describe("POST /api/chat telemetry correlation", () => {
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
