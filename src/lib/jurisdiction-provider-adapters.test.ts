import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { E2E_JURISDICTION_QUESTIONS } from "../../shared/e2e-jurisdiction-provider-contract";
import {
  createChatProvider,
  createPlacesProvider,
  createResearchProvider,
  createTopicProvider,
  type ResearchStore,
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

function researchStores(count = 1): ResearchStore[] {
  return Array.from({ length: count }, (_, index) => ({
    jurisdictionId: index === 0 ? "accra" : `ancestor-${index}`,
    name: index === 0 ? "Accra" : `Ancestor ${index}`,
    kind: "geographic",
    relation: index === 0 ? "selected" : "geographic_ancestor",
    storeName: `fileSearchStores/law-${index}`,
    documents: [{
      resourceId: `resource-${index}`,
      versionId: `version-${index}`,
      documentName: `fileSearchStores/law-${index}/documents/document-${index}`,
    }],
  }));
}

const retrievalOptions = {
  timeoutMs: 10_000,
  signal: new AbortController().signal,
};

describe("isolated jurisdiction provider adapters", () => {
  it("selects stub mode before provider keys, constructors, imports, or fetch", async () => {
    const environment = stubEnvironment();
    let keyReads = 0;
    Object.defineProperties(environment, {
      GOOGLE_AI_API_KEY: { get: () => { keyReads += 1; return "must-not-read"; } },
    });
    const createGoogleClient = vi.fn();
    const createProviderClient = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const topic = createTopicProvider(environment, { createGoogleClient });
    const research = createResearchProvider(environment, { createProviderClient });
    await expect(topic.generate(E2E_JURISDICTION_QUESTIONS.complete, topicRequest))
      .resolves.toEqual({ text: '{"geographicHints":["Accra"],"ancestorDepth":3}' });
    await expect(research.search({
      query: E2E_JURISDICTION_QUESTIONS.complete,
      stores: researchStores(),
    }, retrievalOptions)).resolves.toMatchObject({
      sources: [{ spans: [{ content: "Isolated Accra selected legal research evidence." }] }],
    });

    expect(keyReads).toBe(0);
    expect(createGoogleClient).not.toHaveBeenCalled();
    expect(createProviderClient).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("uses exact shared questions and rejects unknown input before real seams", async () => {
    const createGoogleClient = vi.fn();
    const createProviderClient = vi.fn();
    const topic = createTopicProvider(stubEnvironment(), { createGoogleClient });
    const research = createResearchProvider(stubEnvironment(), { createProviderClient });

    await expect(topic.generate(`${E2E_JURISDICTION_QUESTIONS.complete} `, topicRequest))
      .rejects.toThrow("E2E_JURISDICTION_PROVIDER_SCENARIO_INVALID");
    await expect(research.search({ query: "What rules apply?", stores: researchStores() }, retrievalOptions))
      .rejects.toThrow("E2E_JURISDICTION_PROVIDER_SCENARIO_INVALID");
    expect(createGoogleClient).not.toHaveBeenCalled();
    expect(createProviderClient).not.toHaveBeenCalled();
  });

  it("returns ordered evidence, omits a failed supplement, and rejects selected failure", async () => {
    const complete = createResearchProvider(stubEnvironment());
    await expect(complete.search({
      query: E2E_JURISDICTION_QUESTIONS.complete,
      stores: researchStores(4),
    }, retrievalOptions)).resolves.toMatchObject({
      sources: [
        { spans: [{ content: "Isolated Accra selected legal research evidence." }] },
        { spans: [{ content: "Isolated Accra supplementary legal research evidence 1." }] },
        { spans: [{ content: "Isolated Accra supplementary legal research evidence 2." }] },
        { spans: [{ content: "Isolated Accra supplementary legal research evidence 3." }] },
      ],
    });

    const supplementaryFailure = createResearchProvider(stubEnvironment());
    await expect(supplementaryFailure.search({
      query: E2E_JURISDICTION_QUESTIONS.supplementary_failure,
      stores: researchStores(3),
    }, retrievalOptions)).resolves.toMatchObject({
      sources: [
        { jurisdictionId: "accra" },
        { jurisdictionId: "ancestor-2" },
      ],
    });

    const selectedFailure = createResearchProvider(stubEnvironment());
    await expect(selectedFailure.search({
      query: E2E_JURISDICTION_QUESTIONS.selected_failure,
      stores: researchStores(2),
    }, retrievalOptions)).rejects.toThrow("E2E_JURISDICTION_STUB_SELECTED_FAILURE");
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
    const createProviderClient = vi.fn(() => {
      throw new Error("factory unavailable");
    });
    const research = createResearchProvider(
      { GOOGLE_AI_API_KEY: "google-key" },
      { createProviderClient },
    );

    await expect(research.initialize()).rejects.toThrow("factory unavailable");
    await expect(research.initialize()).rejects.toThrow("factory unavailable");
    expect(createProviderClient).toHaveBeenCalledOnce();
  });

  it("preserves topic and research provider call shapes through injected real factories", async () => {
    const topicResult = { text: '{"geographicHints":[],"ancestorDepth":0}' };
    const generateContent = vi.fn().mockResolvedValue(topicResult);
    const createGoogleClient = vi.fn().mockResolvedValue({
      models: { generateContent },
    });
    const evidence = "real projected evidence";
    const create = vi.fn().mockResolvedValue({
      steps: [{
        type: "model_output",
        content: [{
          type: "text",
          text: evidence,
          annotations: [{
            type: "file_citation",
            custom_metadata: {
              jurisdiction_id: "accra",
              resource_id: "resource-0",
              version_id: "version-0",
            },
            document_uri: "https://generativelanguage.googleapis.com/v1beta/files/provider-document",
            source: "https://example.test/source-attribution",
            start_index: 0,
            end_index: evidence.length,
          }],
        }],
      }],
    });
    const createProviderClient = vi.fn().mockResolvedValue({ interactions: { create } });
    const environment = {
      GOOGLE_AI_API_KEY: "google-key",
    };
    const topic = createTopicProvider(environment, { createGoogleClient });
    const research = createResearchProvider(environment, { createProviderClient });
    const signal = new AbortController().signal;

    await expect(topic.generate("normal question", topicRequest)).resolves.toBe(topicResult);
    await expect(research.search({ query: "normal query", stores: researchStores() }, { timeoutMs: 2_500, signal }))
      .resolves.toMatchObject({ sources: [{ jurisdictionId: "accra", spans: [{ content: "real projected evidence" }] }] });

    expect(createGoogleClient).toHaveBeenCalledOnce();
    expect(createGoogleClient).toHaveBeenCalledWith("google-key");
    expect(generateContent).toHaveBeenCalledWith(topicRequest);
    expect(createProviderClient).toHaveBeenCalledOnce();
    expect(createProviderClient).toHaveBeenCalledWith("google-key");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: "gemini-3.5-flash-lite",
      tools: [{ type: "file_search", file_search_store_names: ["fileSearchStores/law-0"] }],
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("reports missing normal credentials without constructing a real client", async () => {
    const createGoogleClient = vi.fn();
    const createProviderClient = vi.fn();
    const topic = createTopicProvider({}, { createGoogleClient });
    const research = createResearchProvider({}, { createProviderClient });

    await expect(topic.generate("normal question", topicRequest))
      .rejects.toThrow("TOPIC_PLANNER_NOT_CONFIGURED");
    await expect(research.search({ query: "normal question", stores: researchStores() }, {
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    }))
      .rejects.toThrow("RESEARCH_PROVIDER_NOT_CONFIGURED");
    expect(createGoogleClient).not.toHaveBeenCalled();
    expect(createProviderClient).not.toHaveBeenCalled();
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
      model: "gemini-3.5-flash-lite",
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

  it("asks Gemini to format governed answer values as Markdown with real line breaks", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      text: JSON.stringify({ answer: "Formatted answer", citations: [] }),
    });
    const create = vi.fn().mockReturnValue({ sendMessage });
    const createGoogleClient = vi.fn().mockResolvedValue({ chats: { create } });
    const chat = createChatProvider(
      { GOOGLE_AI_API_KEY: "google-key" },
      { createGoogleClient },
    );

    await chat.generate({
      mode: "governed",
      scenarioQuestion: "normal question",
      query: "normal question",
      context: "governed context",
      history: [],
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        systemInstruction: expect.stringMatching(/Markdown[\s\S]*real line breaks/u),
      }),
    }));
  });

  it("passes cancellation through to a streamed chat request", async () => {
    const sendMessageStream = vi.fn().mockResolvedValue((async function* () {
      yield { text: "streamed answer" };
    })());
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    const createGoogleClient = vi.fn().mockResolvedValue({ chats: { create } });
    const chat = createChatProvider(
      { GOOGLE_AI_API_KEY: "google-key" },
      { createGoogleClient },
    );
    const controller = new AbortController();
    const chunks: string[] = [];

    for await (const chunk of chat.stream({
      mode: "legacy",
      scenarioQuestion: "normal question",
      query: "normal question",
      instruction: "normal instruction",
      history: [],
    }, controller.signal)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["streamed answer"]);
    expect(sendMessageStream).toHaveBeenCalledWith(expect.objectContaining({
      message: "normal question",
      config: expect.objectContaining({ abortSignal: controller.signal }),
    }));
  });

  it("uses the configured chat model for provider requests", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ text: "normal chat answer" });
    const create = vi.fn().mockReturnValue({ sendMessage });
    const createGoogleClient = vi.fn().mockResolvedValue({ chats: { create } });
    const chat = createChatProvider(
      { GOOGLE_AI_API_KEY: "google-key", GOOGLE_AI_MODEL: "gemini-3.5-flash" },
      { createGoogleClient },
    );

    await expect(chat.generate({
      mode: "legacy",
      scenarioQuestion: "normal question",
      query: "normal question",
      instruction: "normal instruction",
      history: [],
    })).resolves.toBe("normal chat answer");

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: "gemini-3.5-flash",
    }));
  });
});
