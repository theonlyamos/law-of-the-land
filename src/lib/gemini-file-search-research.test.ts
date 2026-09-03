import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  GeminiFileSearchResearch,
  MAX_FILE_SEARCH_EVIDENCE_LENGTH,
  resolveFileSearchModel,
  type GeminiInteractionClient,
  type ResearchStore,
} from "./gemini-file-search-research";

const stores: ResearchStore[] = [
  {
    jurisdictionId: "ghana",
    name: "Ghana",
    kind: "geographic",
    relation: "selected",
    storeName: "fileSearchStores/ghana-law",
  },
  {
    jurisdictionId: "accra",
    name: "Accra",
    kind: "geographic",
    relation: "geographic_ancestor",
    storeName: "fileSearchStores/accra-law",
  },
];

function client(response: unknown): GeminiInteractionClient {
  return { interactions: { create: vi.fn().mockResolvedValue(response) } };
}

function textResponse(text: string, annotations: unknown[] = []) {
  return {
    steps: [{
      type: "model_output",
      content: [{ type: "text", text, annotations }],
    }],
  };
}

function fileCitation(
  text: string,
  jurisdictionId = "ghana",
  overrides: Record<string, unknown> = {},
) {
  return {
    type: "file_citation",
    custom_metadata: {
      jurisdiction_id: jurisdictionId,
      resource_id: "resource-1",
      version_id: "version-1",
    },
    source: `fileSearchStores/${jurisdictionId}-law/documents/document-1`,
    start_index: 0,
    end_index: new TextEncoder().encode(text).byteLength,
    ...overrides,
  };
}

function response(sources = [{ jurisdictionId: "ghana", content: "The Constitution applies." }]) {
  const text = sources.map(({ content }) => content).join("\n\n");
  let byteOffset = 0;
  const annotations = sources.map(({ jurisdictionId, content }) => {
    const start = byteOffset;
    byteOffset += new TextEncoder().encode(content).byteLength;
    const annotation = fileCitation(text, jurisdictionId, {
      start_index: start,
      end_index: byteOffset,
      page_number: 4,
    });
    byteOffset += 2;
    return annotation;
  });
  return textResponse(text, annotations);
}

describe("GeminiFileSearchResearch", () => {
  it("resolves the server retrieval model in dedicated, fallback, and invalid-value cases", () => {
    expect(resolveFileSearchModel({
      GOOGLE_AI_FILE_SEARCH_MODEL: "dedicated-file-search-model",
      GOOGLE_AI_MODEL: "fallback-model",
    })).toBe("dedicated-file-search-model");
    expect(resolveFileSearchModel({ GOOGLE_AI_MODEL: "fallback-model" })).toBe("fallback-model");
    expect(() => resolveFileSearchModel({ GOOGLE_AI_FILE_SEARCH_MODEL: " " }))
      .toThrow("FILE_SEARCH_MODEL_INVALID");
  });

  it("makes one ordered multi-store interaction and derives citations from validated annotations", async () => {
    const sdk = client(response());
    const research = new GeminiFileSearchResearch({ model: "server-retrieval-model", client: sdk });
    const signal = new AbortController().signal;

    await expect(research.search({ query: "Which constitution applies?", stores }, {
      signal,
      timeoutMs: 10_000,
    })).resolves.toMatchObject({
      sources: [{
        jurisdictionId: "ghana",
        spans: [{
          content: "The Constitution applies.",
          citation: {
            resourceId: "resource-1",
            versionId: "version-1",
            pageNumber: 4,
          },
        }],
      }],
    });

    expect(sdk.interactions.create).toHaveBeenCalledOnce();
    expect(sdk.interactions.create).toHaveBeenCalledWith(expect.objectContaining({
      model: "server-retrieval-model",
      input: {
        type: "text",
        text: JSON.stringify({
          trustedScope: stores.map(({ storeName: _storeName, ...store }) => store),
          untrustedQuestion: "Which constitution applies?",
          instruction: "Answer only from File Search evidence. Keep every factual span directly cited.",
        }),
      },
      tools: [{ type: "file_search", file_search_store_names: [
        "fileSearchStores/ghana-law",
        "fileSearchStores/accra-law",
      ] }],
      response_format: expect.objectContaining({
        type: "text",
        mime_type: "text/plain",
      }),
    }), { signal: expect.any(AbortSignal) });
    expect(vi.mocked(sdk.interactions.create).mock.calls[0][0])
      .not.toHaveProperty("response_mime_type");
  });

  it("derives citations from the Interactions API outputs contract", async () => {
    const text = "The Constitution applies.";
    const research = new GeminiFileSearchResearch({
      model: "server-retrieval-model",
      client: client({
        outputs: [{
          type: "text",
          text,
          annotations: [fileCitation(text, "ghana", { page_number: 4 })],
        }],
      }),
    });

    await expect(research.search({ query: "Which constitution applies?", stores }, {
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    })).resolves.toMatchObject({
      sources: [{
        jurisdictionId: "ghana",
        spans: [{
          content: text,
          citation: {
            resourceId: "resource-1",
            versionId: "version-1",
            pageNumber: 4,
          },
        }],
      }],
    });
  });

  it("emits bounded lookup claims while ignoring provider provenance fields", async () => {
    const ordinary = new GeminiFileSearchResearch({
      model: "server-retrieval-model",
      client: client(textResponse(
        "evidence",
        [fileCitation("evidence", "ghana", {
            document_uri: "https://generativelanguage.googleapis.com/v1beta/files/provider-document",
            source: "https://example.test/source-attribution",
            file_name: "FORGED TITLE",
          })],
      )),
    });
    const overflowDocument = new GeminiFileSearchResearch({
      model: "server-retrieval-model",
      client: client(textResponse(
        "evidence",
        [fileCitation("evidence", "ghana", {
            custom_metadata: {
              jurisdiction_id: "ghana",
              resource_id: "resource-forged",
              version_id: "version-1",
            },
          })],
      )),
    });

    const ordinaryResult = await ordinary.search({ query: "question", stores }, {
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    });
    expect(ordinaryResult).toMatchObject({
      sources: [{
        jurisdictionId: "ghana",
        spans: [{ citation: {
            resourceId: "resource-1",
            versionId: "version-1",
          } }],
      }],
    });
    expect(ordinaryResult.sources[0].spans[0].citation).toEqual({
      resourceId: "resource-1",
      versionId: "version-1",
    });
    expect(JSON.stringify(ordinaryResult)).not.toMatch(/provider-document|source-attribution|FORGED TITLE/);
    await expect(overflowDocument.search({ query: "question", stores }, {
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    })).resolves.toMatchObject({
      sources: [{
        jurisdictionId: "ghana",
        spans: [{ citation: {
          resourceId: "resource-forged",
          versionId: "version-1",
        } }],
      }],
    });
  });

  it("rejects aborts and ignores unknown or duplicate cited spans", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const sdk = client(response());
    const research = new GeminiFileSearchResearch({ model: "server-retrieval-model", client: sdk });
    await expect(research.search({ query: "question", stores }, { signal: aborted.signal, timeoutMs: 1 }))
      .rejects.toThrow("FILE_SEARCH_ABORTED");
    expect(sdk.interactions.create).not.toHaveBeenCalled();

    await expect(new GeminiFileSearchResearch({
      model: "server-retrieval-model",
      client: client(response([{ jurisdictionId: "unknown", content: "forged" }])),
    }).search({ query: "question", stores }, { signal: new AbortController().signal, timeoutMs: 10_000 }))
      .resolves.toMatchObject({ sources: [] });
    await expect(new GeminiFileSearchResearch({
      model: "server-retrieval-model",
      client: client(response([
        { jurisdictionId: "ghana", content: "one" },
        { jurisdictionId: "ghana", content: "two" },
      ])),
    }).search({ query: "question", stores }, { signal: new AbortController().signal, timeoutMs: 10_000 }))
      .resolves.toMatchObject({ sources: [{
        jurisdictionId: "ghana",
        spans: [{ content: "one" }, { content: "two" }],
      }] });
  });

  it("turns an elapsed interaction deadline into a timeout", async () => {
    const create = vi.fn((_request: unknown, options?: { signal?: AbortSignal }) => new Promise((_, reject) => {
      options?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }));
    const research = new GeminiFileSearchResearch({
      model: "server-retrieval-model",
      client: { interactions: { create } },
    });

    await expect(research.search({ query: "question", stores }, {
      signal: new AbortController().signal,
      timeoutMs: 1,
    })).rejects.toThrow("FILE_SEARCH_TIMEOUT");
  });

  it("honors a caller-provided 60-second deadline", async () => {
    vi.useFakeTimers();
    const create = vi.fn((_request: unknown, options?: { signal?: AbortSignal }) => new Promise((_, reject) => {
      options?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }));
    const research = new GeminiFileSearchResearch({
      model: "server-retrieval-model",
      client: { interactions: { create } },
    });
    const pending = research.search({ query: "question", stores }, {
      signal: new AbortController().signal,
      timeoutMs: 60_000,
    });
    const timeout = expect(pending).rejects.toThrow("FILE_SEARCH_TIMEOUT");

    await vi.advanceTimersByTimeAsync(59_999);
    expect(create).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await timeout;
    vi.useRealTimers();
  });

  it("bounds cited model evidence", async () => {
    const sdk = client(response([{
      jurisdictionId: "ghana",
      content: "a".repeat(MAX_FILE_SEARCH_EVIDENCE_LENGTH + 1),
    }]));
    const research = new GeminiFileSearchResearch({ model: "server-retrieval-model", client: sdk });

    await expect(research.search({ query: "question", stores }, {
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    })).resolves.toMatchObject({
      sources: [{ jurisdictionId: "ghana", spans: [{ content: "a".repeat(MAX_FILE_SEARCH_EVIDENCE_LENGTH) }] }],
    });
  });

  it("rejects raw model text over the provider response limit before parsing", async () => {
    const sdk = client(textResponse("x".repeat(240_001)));
    const research = new GeminiFileSearchResearch({ model: "server-retrieval-model", client: sdk });

    await expect(research.search({ query: "question", stores }, {
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    })).rejects.toThrow("FILE_SEARCH_RESPONSE_INVALID");
  });

  it("rejects oversized query and authorized store inputs before calling Gemini", async () => {
    const sdk = client(response());
    const research = new GeminiFileSearchResearch({ model: "server-retrieval-model", client: sdk });
    const options = { signal: new AbortController().signal, timeoutMs: 10_000 };

    await expect(research.search({ query: "q".repeat(4_001), stores }, options))
      .rejects.toThrow("FILE_SEARCH_REQUEST_INVALID");
    await expect(research.search({ query: "question", stores: [{ ...stores[0], jurisdictionId: "j".repeat(201) }] }, options))
      .rejects.toThrow("FILE_SEARCH_REQUEST_INVALID");
    expect(sdk.interactions.create).not.toHaveBeenCalled();
  });

  it("rejects excessive annotations and excludes oversized citation metadata", async () => {
    const excessiveAnnotations = Array.from({ length: 65 }, () => fileCitation("evidence"));
    const excessive = new GeminiFileSearchResearch({
      model: "server-retrieval-model",
      client: client(textResponse(
        "evidence",
        excessiveAnnotations,
      )),
    });
    await expect(excessive.search({ query: "question", stores }, {
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    })).rejects.toThrow("FILE_SEARCH_RESPONSE_INVALID");

    const oversizedId = new GeminiFileSearchResearch({
      model: "server-retrieval-model",
      client: client(textResponse(
        "evidence",
        [fileCitation("evidence", "ghana", {
            custom_metadata: { jurisdiction_id: "ghana", resource_id: "r".repeat(129), version_id: "version-1" },
          })],
      )),
    });
    await expect(oversizedId.search({ query: "question", stores }, {
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    })).resolves.toMatchObject({ sources: [] });
  });

  it("excludes annotations with oversized metadata strings outside citation identifiers", async () => {
    const research = new GeminiFileSearchResearch({
      model: "server-retrieval-model",
      client: client(textResponse(
        "evidence",
        [fileCitation("evidence", "ghana", {
            custom_metadata: {
              jurisdiction_id: "ghana",
              resource_id: "resource-1",
              version_id: "version-1",
              environment: "e".repeat(201),
            },
          })],
      )),
    });

    await expect(research.search({ query: "question", stores }, {
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    })).resolves.toMatchObject({ sources: [] });
  });
});
