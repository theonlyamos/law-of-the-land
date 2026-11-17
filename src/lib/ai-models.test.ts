import { describe, expect, it } from "vitest";
import { AI_MODEL_FEATURES, AI_MODEL_FEATURE_INFO, normalizeAiModelId, resolveAiModel, resolveAiModels } from "../../shared/ai-models";

describe("AI model resolution", () => {
  it("prefers the admin setting, then environment variables in order, then the default", () => {
    const env = { DOCUMENT_REVIEW_MODEL: "review-env", GEMINI_AI_MODEL: "chat-env" };
    expect(resolveAiModel("document_draft", { document_draft: "draft-admin" }, env)).toBe("draft-admin");
    expect(resolveAiModel("document_draft", null, env)).toBe("review-env");
    expect(resolveAiModel("document_draft", null, { GEMINI_AI_MODEL: " chat-env " })).toBe("chat-env");
    expect(resolveAiModel("document_draft", null, {})).toBe("gemini-3.8-flash");
    expect(resolveAiModel("transcription", null, {})).toBe("gemini-3.5-transcribe");
    expect(resolveAiModel("intent_routing", null, {})).toBe("jev-1.13.0");
  });

  it("covers every feature", () => {
    expect(Object.keys(resolveAiModels(null, {}))).toEqual([...AI_MODEL_FEATURES]);
    for (const feature of AI_MODEL_FEATURES) expect(normalizeAiModelId(feature, AI_MODEL_FEATURE_INFO[feature].defaultModel)).toBe(AI_MODEL_FEATURE_INFO[feature].defaultModel);
  });

  it("normalizes and validates model names", () => {
    expect(normalizeAiModelId("chat", " gemini-3.8-flash ")).toBe("gemini-3.8-flash");
    expect(normalizeAiModelId("chat", "models/gemini-3.8-flash")).toBe("gemini-3.8-flash");
    expect(normalizeAiModelId("embedding", "gemini-embedding-2")).toBe("models/gemini-embedding-2");
    for (const bad of ["", " ", "has space", "a//b", "trailing/", "-leading", "x:y", "a".repeat(129)]) {
      expect(normalizeAiModelId("chat", bad)).toBeNull();
    }
  });
});

describe("Next.js AI model lookup", () => {
  it("falls back to environment and defaults when Convex cannot be reached, and caches the result", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example-123.convex.cloud");
    vi.stubEnv("GEMINI_AI_MODEL", "chat-env");
    const fetch = vi.fn(async () => { throw new Error("offline"); });
    vi.stubGlobal("fetch", fetch);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const lookup = await import("./ai-models");
      lookup.resetAiModelCacheForTests();
      await expect(lookup.getAiModel("chat")).resolves.toBe("chat-env");
      await expect(lookup.getAiModel("transcription")).resolves.toBe("gemini-3.5-transcribe");
      expect(warn).toHaveBeenCalledWith("ai_model_settings", JSON.stringify({ outcome: "unavailable" }));
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      warn.mockRestore();
    }
  });

  it("applies admin settings over environment variables and ignores malformed ones", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example-123.convex.cloud");
    vi.stubEnv("GEMINI_AI_MODEL", "chat-env");
    vi.doMock("convex/browser", () => ({
      ConvexHttpClient: class { async query() { return { chat: "chat-admin", transcription: "bad name", nope: "x" }; } },
    }));
    try {
      const lookup = await import("./ai-models");
      lookup.resetAiModelCacheForTests();
      const models = await lookup.getAiModels();
      expect(models.chat).toBe("chat-admin");
      expect(models.transcription).toBe("gemini-3.5-transcribe");
    } finally {
      vi.doUnmock("convex/browser");
      vi.unstubAllEnvs();
    }
  });
});
