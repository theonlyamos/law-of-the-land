import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { E2E_JURISDICTION_QUESTIONS } from "../../shared/e2e-jurisdiction-provider-contract";
import {
  createResearchProvider,
  createTopicProvider,
  type ResearchCall,
} from "./jurisdiction-provider-adapters";

const SHA = "a".repeat(40);
const OBSERVATION_SECRET = "c3R1Yi1vYnNlcnZhdGlvbi1zZWNyZXQtMzItYnl0ZXM";

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
});

describe("normal jurisdiction provider adapters", () => {
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
});
