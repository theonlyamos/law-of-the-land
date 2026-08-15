import "server-only";

import type { GenerateContentParameters } from "@google/genai";

import { E2E_FIXTURE_TOWN_ALIAS } from "../../shared/e2e-jurisdiction-provider-contract";
import {
  resolveJurisdictionProviderMode,
  type JurisdictionProviderMode,
} from "./e2e-jurisdiction-provider-isolation";
import type { ResearchRelation, RetrievalExecutionOptions } from "./research-limits";

type Environment = Record<string, string | undefined>;
export type { JurisdictionProviderMode } from "./e2e-jurisdiction-provider-isolation";

type TopicResponse = { text?: string };
type TopicClient = {
  models: { generateContent(request: GenerateContentParameters): Promise<TopicResponse> };
};
type TopicDependencies = {
  createGoogleClient?(apiKey: string): TopicClient | Promise<TopicClient>;
};

type GroundxResponse = { data: { search: { text?: unknown } } };
type ResearchClient = {
  search: {
    content(
      request: { id: number; query: string },
      options?: { timeout: number; signal: AbortSignal },
    ): Promise<GroundxResponse>;
  };
};
type ResearchDependencies = {
  createGroundxClient?(apiKey: string): ResearchClient | Promise<ResearchClient>;
};

export type TopicProvider = {
  generate(question: string, request: GenerateContentParameters): Promise<TopicResponse>;
};

export type ResearchCall = {
  ordinal: 0 | 1 | 2 | 3;
  relation: ResearchRelation;
  bucketId: number;
  query: string;
};

export type ResearchProvider = {
  initialize(): Promise<void>;
  search(call: ResearchCall, options?: RetrievalExecutionOptions): Promise<string>;
};

async function defaultGoogleClient(apiKey: string): Promise<TopicClient> {
  const { GoogleGenAI } = await import("@google/genai");
  return new GoogleGenAI({ apiKey });
}

async function defaultGroundxClient(apiKey: string): Promise<ResearchClient> {
  const { Groundx } = await import("groundx-typescript-sdk");
  return new Groundx({ apiKey });
}

export function createTopicProvider(
  environment: Environment,
  dependencies: TopicDependencies = {},
  resolvedMode: JurisdictionProviderMode = resolveJurisdictionProviderMode(environment),
): TopicProvider {
  if (resolvedMode.mode === "stub") {
    return {
      async generate(question) {
        resolvedMode.scenarioForQuestion(question);
        return {
          text: JSON.stringify({
            geographicHints: [E2E_FIXTURE_TOWN_ALIAS],
            ancestorDepth: 3,
          }),
        };
      },
    };
  }

  let clientPromise: Promise<TopicClient> | undefined;
  return {
    async generate(_question, request) {
      const apiKey = environment.GOOGLE_AI_API_KEY;
      if (!apiKey) throw new Error("TOPIC_PLANNER_NOT_CONFIGURED");
      clientPromise ??= Promise.resolve(
        (dependencies.createGoogleClient ?? defaultGoogleClient)(apiKey),
      );
      const client = await clientPromise;
      return await client.models.generateContent(request);
    },
  };
}

function stubResearch(call: ResearchCall, scenario: JurisdictionProviderMode & { mode: "stub" }) {
  const selectedScenario = scenario.scenarioForQuestion(call.query);
  if (selectedScenario === "selected_failure" && call.ordinal === 0) {
    throw new Error("E2E_JURISDICTION_STUB_SELECTED_FAILURE");
  }
  if (selectedScenario === "supplementary_failure" && call.ordinal === 1) {
    throw new Error("E2E_JURISDICTION_STUB_SUPPLEMENTARY_FAILURE");
  }
  return call.ordinal === 0
    ? `Isolated ${E2E_FIXTURE_TOWN_ALIAS} selected legal research evidence.`
    : `Isolated ${E2E_FIXTURE_TOWN_ALIAS} supplementary legal research evidence ${call.ordinal}.`;
}

export function createResearchProvider(
  environment: Environment,
  dependencies: ResearchDependencies = {},
  resolvedMode: JurisdictionProviderMode = resolveJurisdictionProviderMode(environment),
): ResearchProvider {
  if (resolvedMode.mode === "stub") {
    return {
      async initialize() {},
      async search(call) {
        return stubResearch(call, resolvedMode);
      },
    };
  }

  let clientPromise: Promise<ResearchClient> | undefined;
  function client(): Promise<ResearchClient> {
    if (clientPromise) return clientPromise;
    const apiKey = environment.GROUNDX_API_KEY;
    clientPromise = apiKey
      ? Promise.resolve().then(
        () => (dependencies.createGroundxClient ?? defaultGroundxClient)(apiKey),
      )
      : Promise.reject(new Error("RESEARCH_PROVIDER_NOT_CONFIGURED"));
    return clientPromise;
  }
  return {
    async initialize() {
      await client();
    },
    async search(call, options) {
      const initializedClient = await client();
      const request = { id: call.bucketId, query: call.query };
      const response = options
        ? await initializedClient.search.content(request, {
          timeout: options.timeoutMs,
          signal: options.signal,
        })
        : await initializedClient.search.content(request);
      return typeof response.data.search.text === "string"
        ? response.data.search.text
        : "";
    },
  };
}
