import "server-only";

import { DEFAULT_RETRIEVAL_TIMEOUT_MS } from "./research-limits";

export const DEFAULT_FILE_SEARCH_MODEL = "gemini-3.5-flash-lite";
export const MAX_FILE_SEARCH_EVIDENCE_LENGTH = 60_000;
const MAX_STORES = 4;
const MAX_QUERY_LENGTH = 4_000;
const MAX_JURISDICTION_ID_LENGTH = 200;
const MAX_STORE_NAME_LENGTH = 128;
const MAX_RAW_PROVIDER_CONTENT_LENGTH = 240_000;
const MAX_INTERACTION_STEPS = 128;
const MAX_MODEL_OUTPUT_BLOCKS = 32;
const MAX_ANNOTATIONS = 64;
const MAX_CITATIONS_PER_SOURCE = 16;
const MAX_CITATION_IDENTIFIER_LENGTH = 200;

export type ResearchStore = {
  jurisdictionId: string;
  name: string;
  kind: "geographic" | "organizational";
  relation: "selected" | "geographic_ancestor" | "organizational_geography";
  storeName: string;
  documents?: Array<{
    resourceId: string;
    versionId: string;
    documentName: string;
  }>;
};

export type ResearchResult = {
  sources: Array<{
    jurisdictionId: string;
    spans: Array<{
      content: string;
      citation: {
        resourceId: string;
        versionId: string;
        documentName: string;
        pageNumber?: number;
      };
    }>;
  }>;
  latencyMs: number;
};

export type GeminiInteractionClient = {
  interactions: {
    create(request: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  };
};

export function resolveFileSearchModel(environment: Record<string, string | undefined>): string {
  const configured = environment.GOOGLE_AI_FILE_SEARCH_MODEL ?? environment.GOOGLE_AI_MODEL;
  if (configured === undefined) return DEFAULT_FILE_SEARCH_MODEL;
  const model = configured.trim();
  if (!model) throw new Error("FILE_SEARCH_MODEL_INVALID");
  return model;
}

function invalidResponse(): never {
  throw new Error("FILE_SEARCH_RESPONSE_INVALID");
}

const DOCUMENT_NAME_PATTERN = /^fileSearchStores\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\/documents\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;

function interactionEvidence(
  response: unknown,
  stores: readonly ResearchStore[],
): ResearchResult["sources"] {
  if (!response || typeof response !== "object" || Array.isArray(response)) return invalidResponse();
  const outputs = (response as { outputs?: unknown }).outputs;
  const steps = outputs === undefined
    ? (response as { steps?: unknown }).steps
    : Array.isArray(outputs) && outputs.length <= MAX_MODEL_OUTPUT_BLOCKS
      ? [{ type: "model_output", content: outputs }]
      : invalidResponse();
  if (!Array.isArray(steps) || steps.length > MAX_INTERACTION_STEPS) return invalidResponse();
  const storesById = new Map(stores.map((store) => [store.jurisdictionId, store]));
  const evidence = new Map<string, {
    contentLength: number;
    spans: ResearchResult["sources"][number]["spans"];
  }>();
  let rawContentLength = 0;
  let annotationCount = 0;
  let sawText = false;
  for (const step of steps) {
    if (!step || typeof step !== "object" || Array.isArray(step) || (step as { type?: unknown }).type !== "model_output") continue;
    const blocks = (step as { content?: unknown }).content;
    if (!Array.isArray(blocks) || blocks.length > MAX_MODEL_OUTPUT_BLOCKS) return invalidResponse();
    for (const block of blocks) {
      if (!block || typeof block !== "object" || Array.isArray(block) || (block as { type?: unknown }).type !== "text") continue;
      const text = (block as { text?: unknown }).text;
      const annotations = (block as { annotations?: unknown }).annotations;
      if (typeof text !== "string" || (annotations !== undefined && !Array.isArray(annotations))) return invalidResponse();
      sawText = true;
      rawContentLength += text.length;
      if (rawContentLength > MAX_RAW_PROVIDER_CONTENT_LENGTH) return invalidResponse();
      const textBytes = new TextEncoder().encode(text);
      const blockAnnotations = Array.isArray(annotations) ? annotations : [];
      annotationCount += blockAnnotations.length;
      if (annotationCount > MAX_ANNOTATIONS) return invalidResponse();
      for (const annotation of blockAnnotations) {
    if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) continue;
    const value = annotation as {
      type?: unknown;
      custom_metadata?: unknown;
      document_uri?: unknown;
      source?: unknown;
      page_number?: unknown;
      start_index?: unknown;
      end_index?: unknown;
    };
    if (value.type !== "file_citation" || !value.custom_metadata || typeof value.custom_metadata !== "object" || Array.isArray(value.custom_metadata)) continue;
    const metadata = value.custom_metadata as Record<string, unknown>;
    if (
      Object.keys(metadata).length > 6
      || Object.values(metadata).some((item) => typeof item === "string" && item.length > MAX_CITATION_IDENTIFIER_LENGTH)
    ) continue;
    const jurisdictionId = metadata.jurisdiction_id;
    const resourceId = metadata.resource_id;
    const versionId = metadata.version_id;
    if (
      typeof jurisdictionId !== "string" || jurisdictionId.length > MAX_JURISDICTION_ID_LENGTH || !storesById.has(jurisdictionId)
      || typeof resourceId !== "string" || !resourceId || resourceId.length > MAX_CITATION_IDENTIFIER_LENGTH
      || typeof versionId !== "string" || !versionId || versionId.length > MAX_CITATION_IDENTIFIER_LENGTH
    ) continue;
    const expectedStore = storesById.get(jurisdictionId)!;
    const authorizedDocuments = (expectedStore.documents ?? []).filter((document) =>
      document.resourceId === resourceId
      && document.versionId === versionId
      && DOCUMENT_NAME_PATTERN.test(document.documentName)
      && document.documentName.startsWith(`${expectedStore.storeName}/documents/`)
    );
    if (authorizedDocuments.length !== 1) continue;
    const documentName = authorizedDocuments[0].documentName;
    const start = value.start_index;
    const end = value.end_index;
    if (
      typeof start !== "number" || !Number.isSafeInteger(start) || start < 0
      || typeof end !== "number" || !Number.isSafeInteger(end) || end <= start
      || end > textBytes.byteLength
    ) continue;
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(textBytes.slice(start, end)).trim();
    } catch {
      continue;
    }
    if (!content) continue;
    const pageNumber = typeof value.page_number === "number" && Number.isInteger(value.page_number) && value.page_number > 0 && value.page_number <= 10_000
      ? value.page_number
      : undefined;
    const citation = {
      resourceId,
      versionId,
      documentName,
      ...(pageNumber === undefined ? {} : { pageNumber }),
    };
    const current = evidence.get(jurisdictionId) ?? { contentLength: 0, spans: [] };
    const remaining = MAX_FILE_SEARCH_EVIDENCE_LENGTH - current.contentLength;
    if (remaining <= 0 || current.spans.length >= MAX_CITATIONS_PER_SOURCE) continue;
    let boundedContent = content.slice(0, remaining);
    if (/^[\uD800-\uDBFF]/u.test(boundedContent.slice(-1))) boundedContent = boundedContent.slice(0, -1);
    if (!boundedContent || current.spans.some((span) =>
      span.content === boundedContent
      && span.citation.resourceId === citation.resourceId
      && span.citation.versionId === citation.versionId
      && span.citation.documentName === citation.documentName
      && span.citation.pageNumber === citation.pageNumber
    )) continue;
    current.spans.push({ content: boundedContent, citation });
    current.contentLength += boundedContent.length;
    evidence.set(jurisdictionId, current);
      }
    }
  }
  if (!sawText) return invalidResponse();
  return stores.flatMap((store) => {
    const source = evidence.get(store.jurisdictionId);
    return source?.spans.length ? [{ jurisdictionId: store.jurisdictionId, spans: source.spans }] : [];
  });
}

export class GeminiFileSearchResearch {
  constructor(private readonly options: { model: string; client: GeminiInteractionClient }) {
    if (!options.model.trim()) throw new Error("FILE_SEARCH_MODEL_INVALID");
  }

  async search(
    input: { query: string; stores: ResearchStore[] },
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<ResearchResult> {
    if (options.signal.aborted) throw new Error("FILE_SEARCH_ABORTED");
    if (typeof input.query !== "string" || !Array.isArray(input.stores) || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || !input.query.trim() || input.query.length > MAX_QUERY_LENGTH || input.stores.length === 0 || input.stores.length > MAX_STORES) {
      throw new Error("FILE_SEARCH_REQUEST_INVALID");
    }
    const authorizedIds = new Set<string>();
    for (const store of input.stores) {
      if (
        !store || typeof store.jurisdictionId !== "string" || !store.jurisdictionId || store.jurisdictionId.length > MAX_JURISDICTION_ID_LENGTH
        || typeof store.storeName !== "string" || !store.storeName || store.storeName.length > MAX_STORE_NAME_LENGTH
        || typeof store.name !== "string" || !store.name || store.name.length > MAX_JURISDICTION_ID_LENGTH
        || (store.kind !== "geographic" && store.kind !== "organizational")
        || (store.relation !== "selected" && store.relation !== "geographic_ancestor" && store.relation !== "organizational_geography")
        || authorizedIds.has(store.jurisdictionId)
      ) throw new Error("FILE_SEARCH_REQUEST_INVALID");
      authorizedIds.add(store.jurisdictionId);
    }

    const timeoutMs = Math.min(options.timeoutMs, DEFAULT_RETRIEVAL_TIMEOUT_MS);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await this.options.client.interactions.create({
        model: this.options.model,
        input: {
          type: "text",
          text: JSON.stringify({
            trustedScope: input.stores.map(({ storeName: _storeName, documents: _documents, ...store }) => store),
            untrustedQuestion: input.query,
            instruction: "Answer only from File Search evidence. Keep every factual span directly cited.",
          }),
        },
        tools: [{ type: "file_search", file_search_store_names: input.stores.map((store) => store.storeName) }],
        response_format: {
          type: "text",
          mime_type: "text/plain",
        },
      }, { signal: controller.signal });
      if (options.signal.aborted) throw new Error("FILE_SEARCH_ABORTED");
      if (controller.signal.aborted) throw new Error("FILE_SEARCH_TIMEOUT");
      return {
        sources: interactionEvidence(response, input.stores),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (options.signal.aborted) throw new Error("FILE_SEARCH_ABORTED");
      if (controller.signal.aborted) throw new Error("FILE_SEARCH_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
    }
  }
}
