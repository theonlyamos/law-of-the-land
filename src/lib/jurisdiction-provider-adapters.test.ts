import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { E2E_JURISDICTION_QUESTIONS } from "../../shared/e2e-jurisdiction-provider-contract";
import {
  createChatProvider,
  createPlacesProvider,
  createResearchProvider,
  createTopicProvider,
  type ResearchCall,
} from "./jurisdiction-provider-adapters";

const SHA = "a".repeat(40);
const OBSERVATION_SECRET = "c3R1Yi1vYnNlcnZhdGlvbi1zZWNyZXQtMzItYnl0ZXM";
const SESSION_TOKEN = "de305d54-75b4-431b-adb2-eb6b9e546014";
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

function stubEnvironment(): Record<string, string | undefined> {
  return {
    ADMIN_E2E_FIXTURE_MODE: "true",
    ADMIN_E2E_TARGET_ENV: "test",
    ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e",
    ADMIN_E2E_PROVIDER_STUB_MODE: "true",
    ADMIN_E2E_CONVEX_URL: "http://127.0.0.1:3210",
    ADMIN_E2E_CONVEX_SITE_URL: "http://127.0.0.1:3211",
    ADMIN_E2E_APPROVED_COMMIT_SHA: SHA,
    ADMIN_E2E_LOCAL_HEAD_SHA: SHA,
    ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: OBSERVATION_SECRET,
  };
}

const topicRequest = {
  model: "test-model",
  contents: [{ role: "user", parts: [{ text: "untrusted" }] }],
} satisfies GenerateContentParameters;

function researchCall(
  query: string,
  ordinal: 0 | 1 | 2 | 3 = 0,
): ResearchCall {
  return {
    ordinal,
    relation: ordinal === 0 ? "selected" : "geographic_ancestor",
    bucketId: 100 + ordinal,
    query,
  };
}

describe("isolated jurisdiction provider adapters", () => {
  it("selects stub mode before provider keys, constructors, imports, or fetch", async () => {
    const environment = stubEnvironment();
    let keyReads = 0;
    Object.defineProperties(environment, {
      GOOGLE_AI_API_KEY: { get: () => { keyReads += 1; return "must-not-read"; } },
      GROUNDX_API_KEY: { get: () => { keyReads += 1; return "must-not-read"; } },
    });
    const createGoogleClient = vi.fn();
    const createGroundxClient = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const topic = createTopicProvider(environment, { createGoogleClient });
    const research = createResearchProvider(environment, { createGroundxClient });
    await expect(topic.generate(E2E_JURISDICTION_QUESTIONS.complete, topicRequest))
      .resolves.toEqual({ text: '{"geographicHints":["Accra"],"ancestorDepth":3}' });
    await expect(research.search(researchCall(E2E_JURISDICTION_QUESTIONS.complete)))
      .resolves.toBe("Isolated Accra selected legal research evidence.");

    expect(keyReads).toBe(0);
    expect(createGoogleClient).not.toHaveBeenCalled();
    expect(createGroundxClient).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("uses exact shared questions and rejects unknown input before real seams", async () => {
    const createGoogleClient = vi.fn();
    const createGroundxClient = vi.fn();
    const topic = createTopicProvider(stubEnvironment(), { createGoogleClient });
    const research = createResearchProvider(stubEnvironment(), { createGroundxClient });

    await expect(topic.generate(`${E2E_JURISDICTION_QUESTIONS.complete} `, topicRequest))
      .rejects.toThrow("E2E_JURISDICTION_PROVIDER_SCENARIO_INVALID");
    await expect(research.search(researchCall("What rules apply?")))
      .rejects.toThrow("E2E_JURISDICTION_PROVIDER_SCENARIO_INVALID");
    expect(createGoogleClient).not.toHaveBeenCalled();
    expect(createGroundxClient).not.toHaveBeenCalled();
  });

  it("returns ordered selected and supplementary evidence and only rejects the requested call", async () => {
    const complete = createResearchProvider(stubEnvironment());
    await expect(Promise.all([0, 1, 2, 3].map((ordinal) => complete.search(researchCall(
      E2E_JURISDICTION_QUESTIONS.complete,
      ordinal as 0 | 1 | 2 | 3,
    ))))).resolves.toEqual([
      "Isolated Accra selected legal research evidence.",
      "Isolated Accra supplementary legal research evidence 1.",
      "Isolated Accra supplementary legal research evidence 2.",
      "Isolated Accra supplementary legal research evidence 3.",
    ]);

    const supplementaryFailure = createResearchProvider(stubEnvironment());
    await expect(supplementaryFailure.search(researchCall(
      E2E_JURISDICTION_QUESTIONS.supplementary_failure,
      1,
    ))).rejects.toThrow("E2E_JURISDICTION_STUB_SUPPLEMENTARY_FAILURE");
    await expect(supplementaryFailure.search(researchCall(
      E2E_JURISDICTION_QUESTIONS.supplementary_failure,
      2,
    ))).resolves.toContain("evidence 2");

    const selectedFailure = createResearchProvider(stubEnvironment());
    await expect(selectedFailure.search(researchCall(
      E2E_JURISDICTION_QUESTIONS.selected_failure,
    ))).rejects.toThrow("E2E_JURISDICTION_STUB_SELECTED_FAILURE");
    await expect(selectedFailure.search(researchCall(
      E2E_JURISDICTION_QUESTIONS.selected_failure,
      1,
    ))).resolves.toContain("evidence 1");
  });

  it.each(CHAT_STUB_CASES)(
    "returns bounded governed J1 output for the exact %s chat question",
    async (_scenario, question, expectedAnswer) => {
      const createGoogleClient = vi.fn();
      const chat = createChatProvider(stubEnvironment(), { createGoogleClient });

      const text = await chat.generate({
        mode: "governed",
        scenarioQuestion: question,
        query: question,
        context: "governed server context",
        history: [],
      });

      expect(JSON.parse(text ?? "")).toEqual({
        answer: expectedAnswer,
        citations: [{ sourceRef: "J1", label: "Isolated Accra legal evidence" }],
      });
      expect(text).not.toMatch(/jurisdictionId|jurisdictionName|selected-jurisdiction/);
      expect(createGoogleClient).not.toHaveBeenCalled();
    },
  );

  it("returns a compatible plain legacy answer and rejects unknown chat questions before real seams", async () => {
    let keyReads = 0;
    const environment = stubEnvironment();
    Object.defineProperty(environment, "GOOGLE_AI_API_KEY", {
      get: () => { keyReads += 1; return "must-not-read"; },
    });
    const createGoogleClient = vi.fn();
    const chat = createChatProvider(environment, { createGoogleClient });

    await expect(chat.generate({
      mode: "legacy",
      scenarioQuestion: E2E_JURISDICTION_QUESTIONS.complete,
      query: E2E_JURISDICTION_QUESTIONS.complete,
      instruction: "bounded legacy instruction",
      history: [],
    })).resolves.toBe("Isolated Accra complete legal answer.");
    await expect(chat.generate({
      mode: "governed",
      scenarioQuestion: `${E2E_JURISDICTION_QUESTIONS.complete} `,
      query: E2E_JURISDICTION_QUESTIONS.complete,
      context: "governed server context",
      history: [],
    })).rejects.toThrow("E2E_JURISDICTION_PROVIDER_SCENARIO_INVALID");

    expect(keyReads).toBe(0);
    expect(createGoogleClient).not.toHaveBeenCalled();
  });

  it("binds the stub place ID to the autocomplete session and never reaches real Places seams", async () => {
    let keyReads = 0;
    const environment = stubEnvironment();
    Object.defineProperty(environment, "PLACES_API_KEY", {
      get: () => { keyReads += 1; return "must-not-read"; },
    });
    const autocomplete = vi.fn();
    const details = vi.fn();
    const places = createPlacesProvider(environment, { autocomplete, details });

    const suggestions = await places.autocomplete("Acc", SESSION_TOKEN);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      primaryText: "Accra",
      secondaryText: "Ghana",
      types: ["locality", "political"],
    });
    await expect(places.details(suggestions[0].placeId, SESSION_TOKEN)).resolves.toMatchObject({
      placeId: suggestions[0].placeId,
      displayName: "Accra",
      formattedAddress: "Accra, Ghana",
      countryCode: "GH",
    });
    await expect(places.details(
      suggestions[0].placeId,
      "de305d54-75b4-431b-adb2-eb6b9e546015",
    )).rejects.toThrow("GOOGLE_PLACES_INVALID_REQUEST");
    await expect(places.details(suggestions[0].placeId, SESSION_TOKEN.toUpperCase()))
      .rejects.toThrow("GOOGLE_PLACES_INVALID_REQUEST");
    await expect(places.details("forged-place", SESSION_TOKEN))
      .rejects.toThrow("GOOGLE_PLACES_INVALID_REQUEST");

    expect(keyReads).toBe(0);
    expect(autocomplete).not.toHaveBeenCalled();
    expect(details).not.toHaveBeenCalled();
  });
});

describe("normal jurisdiction provider adapters", () => {
  it("caches a synchronously rejected chat factory initialization", async () => {
    const createGoogleClient = vi.fn(() => {
      throw new Error("factory unavailable");
    });
    const chat = createChatProvider(
      { GOOGLE_AI_API_KEY: "google-key" },
      { createGoogleClient },
    );
    const call = {
      mode: "legacy" as const,
      scenarioQuestion: "normal question",
      query: "normal question",
      instruction: "normal instruction",
      history: [],
    };

    await expect(chat.generate(call)).rejects.toThrow("factory unavailable");
    await expect(chat.generate(call)).rejects.toThrow("factory unavailable");
    expect(createGoogleClient).toHaveBeenCalledOnce();
  });

  it("caches a synchronously rejected research factory initialization", async () => {
    const createGroundxClient = vi.fn(() => {
      throw new Error("factory unavailable");
    });
    const research = createResearchProvider(
      { GROUNDX_API_KEY: "groundx-key" },
      { createGroundxClient },
    );

    await expect(research.initialize()).rejects.toThrow("factory unavailable");
    await expect(research.initialize()).rejects.toThrow("factory unavailable");
    expect(createGroundxClient).toHaveBeenCalledOnce();
  });

  it("preserves topic and research provider call shapes through injected real factories", async () => {
    const topicResult = { text: '{"geographicHints":[],"ancestorDepth":0}' };
    const generateContent = vi.fn().mockResolvedValue(topicResult);
    const createGoogleClient = vi.fn().mockResolvedValue({
      models: { generateContent },
    });
    const searchContent = vi.fn().mockResolvedValue({
      data: { search: { text: "real projected evidence" } },
    });
    const createGroundxClient = vi.fn().mockResolvedValue({
      search: { content: searchContent },
    });
    const environment = {
      GOOGLE_AI_API_KEY: "google-key",
      GROUNDX_API_KEY: "groundx-key",
    };
    const topic = createTopicProvider(environment, { createGoogleClient });
    const research = createResearchProvider(environment, { createGroundxClient });
    const signal = new AbortController().signal;
    const call = researchCall("normal query", 1);

    await expect(topic.generate("normal question", topicRequest)).resolves.toBe(topicResult);
    await expect(research.search(call, { timeoutMs: 2_500, signal }))
      .resolves.toBe("real projected evidence");
    await expect(research.search(researchCall("legacy query"))).resolves.toBe("real projected evidence");

    expect(createGoogleClient).toHaveBeenCalledOnce();
    expect(createGoogleClient).toHaveBeenCalledWith("google-key");
    expect(generateContent).toHaveBeenCalledWith(topicRequest);
    expect(createGroundxClient).toHaveBeenCalledOnce();
    expect(createGroundxClient).toHaveBeenCalledWith("groundx-key");
    expect(searchContent.mock.calls).toEqual([
      [{ id: call.bucketId, query: call.query }, { timeout: 2_500, signal }],
      [{ id: 100, query: "legacy query" }],
    ]);
  });

  it("reports missing normal credentials without constructing a real client", async () => {
    const createGoogleClient = vi.fn();
    const createGroundxClient = vi.fn();
    const topic = createTopicProvider({}, { createGoogleClient });
    const research = createResearchProvider({}, { createGroundxClient });

    await expect(topic.generate("normal question", topicRequest))
      .rejects.toThrow("TOPIC_PLANNER_NOT_CONFIGURED");
    await expect(research.search(researchCall("normal question")))
      .rejects.toThrow("RESEARCH_PROVIDER_NOT_CONFIGURED");
    expect(createGoogleClient).not.toHaveBeenCalled();
    expect(createGroundxClient).not.toHaveBeenCalled();
  });

  it("preserves normal chat and Places call shapes through injected real seams", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ text: "normal chat answer" });
    const create = vi.fn().mockReturnValue({ sendMessage });
    const createGoogleClient = vi.fn().mockResolvedValue({ chats: { create } });
    const chat = createChatProvider(
      { GOOGLE_AI_API_KEY: "google-key" },
      { createGoogleClient },
    );
    const autocomplete = vi.fn().mockResolvedValue([]);
    const details = vi.fn().mockResolvedValue({ placeId: "normal-place" });
    const places = createPlacesProvider({}, { autocomplete, details });

    await expect(chat.generate({
      mode: "legacy",
      scenarioQuestion: "normal question",
      query: "normal question",
      instruction: "normal instruction",
      history: [{ role: "assistant", content: "prior answer" }],
    })).resolves.toBe("normal chat answer");
    await expect(places.autocomplete("Acc", SESSION_TOKEN)).resolves.toEqual([]);
    await expect(places.details("normal-place", SESSION_TOKEN))
      .resolves.toEqual({ placeId: "normal-place" });

    expect(createGoogleClient).toHaveBeenCalledOnce();
    expect(createGoogleClient).toHaveBeenCalledWith("google-key");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: "gemini-3.1-flash-lite-preview",
      config: expect.objectContaining({
        responseMimeType: "text/plain",
        tools: [{ googleSearch: {} }],
      }),
      history: [{ role: "model", parts: [{ text: "prior answer" }] }],
    }));
    expect(sendMessage).toHaveBeenCalledWith({ message: "normal question" });
    expect(autocomplete).toHaveBeenCalledWith("Acc", SESSION_TOKEN);
    expect(details).toHaveBeenCalledWith("normal-place", SESSION_TOKEN);
  });
});
