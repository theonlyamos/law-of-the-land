import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { classifyChatIntent, exactFormality } from "./chat-intent-routing";

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
    const result = await classifyChatIntent("What does this mean?", [], new AbortController().signal, "on");
    expect(result).toBe("legal");
    expect(fetch).toHaveBeenCalledTimes(1);
  }, 6_000);
});
