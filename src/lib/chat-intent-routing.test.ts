import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { classifyChatIntent, exactFormality, isOpenLegalFollowUp } from "./chat-intent-routing";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TYPESAFE_API_KEY;
});

describe("legal chat intent routing", () => {
  it("matches only whole-turn formalities", () => {
    expect(exactFormality("  Hello!! ")).toBe(true);
    expect(exactFormality("Hi, can I appeal?")).toBe(false);
  });

  it("falls back to legal when Jev exceeds the three-second limit", async () => {
    process.env.TYPESAFE_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    })));
    const result = await classifyChatIntent("Can my landlord evict me without notice?", [], new AbortController().signal, "on");
    expect(result).toBe("legal");
    expect(fetch).toHaveBeenCalledTimes(1);
  }, 6_000);

  const followUps = [
    "tell me more about this",
    "Tell me more about this, what is this about?",
    "What is this about?",
    "what's this about",
    "whats this all about",
    "What does this mean?",
    "Tell me more",
    "Can you explain this?",
    "Please elaborate",
    "Summarize this for me",
    "What is this law about?",
    "Tell me about this act",
    "Explain this in simple terms",
    "More details please",
    "What’s that for?",
  ];

  it.each(followUps)("treats %j as a legal question about the selected jurisdiction", (query) => {
    expect(isOpenLegalFollowUp(query)).toBe(true);
  });

  it.each([
    "Tell me more about this movie",
    "What is the weather today?",
    "What is this about? Also write me a poem",
    "Explain this code",
    "Hello",
    "",
  ])("leaves %j to the classifier", (query) => {
    expect(isOpenLegalFollowUp(query)).toBe(false);
  });

  it("answers open follow-ups as legal without asking Jev, even when Jev would say unclear", async () => {
    process.env.TYPESAFE_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: { route: { type: "choice", choice: "unclear", probabilities: { legal: 0, courtesy: 0, unclear: 1, out_of_scope: 0 } } },
    }))));
    for (const query of followUps) {
      await expect(classifyChatIntent(query, [], new AbortController().signal, "on")).resolves.toBe("legal");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still asks Jev about open follow-ups in shadow mode", async () => {
    process.env.TYPESAFE_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: { route: { type: "choice", choice: "legal", probabilities: { legal: 1, courtesy: 0, unclear: 0, out_of_scope: 0 } } },
    }))));
    await expect(classifyChatIntent("Tell me more about this", [], new AbortController().signal, "shadow")).resolves.toBe("legal");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("tells Jev that a jurisdiction is selected and vague requests are legal", async () => {
    process.env.TYPESAFE_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: { route: { type: "choice", choice: "legal", probabilities: { legal: 1, courtesy: 0, unclear: 0, out_of_scope: 0 } } },
    }))));
    await classifyChatIntent("Can my landlord keep my deposit?", [], new AbortController().signal, "on");
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body.state.selectedJurisdiction).toMatch(/selected a jurisdiction/u);
    expect(body.questions.route.instructions).toMatch(/what is this about/u);
    expect(body.questions.route.criteria.legal).toMatch(/tell me more about this/u);
    expect(body.questions.route.criteria.unclear).toMatch(/no request at all/u);
  });
});
