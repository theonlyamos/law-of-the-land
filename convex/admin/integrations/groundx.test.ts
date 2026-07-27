import { describe, expect, it, vi } from "vitest";

import { GroundxAdapter, ProviderError } from "./groundx";

const ingestResult = {
  data: { ingest: { processId: "process-1", status: "queued" } },
};

function makeSdk() {
  return {
    buckets: {
      create: vi.fn().mockResolvedValue({
        data: { bucket: { bucketId: 7, name: "Ghana statutes", fileCount: 0 } },
      }),
    },
    documents: {
      ingestRemote: vi.fn().mockResolvedValue(ingestResult),
      delete: vi.fn().mockResolvedValue(ingestResult),
      getProcessingStatusById: vi.fn().mockResolvedValue({
        data: {
          ingest: {
            processId: "process-1",
            status: "processing",
            statusMessage: "Indexing",
            progress: {
              complete: { total: 2 },
              processing: { total: 1 },
              errors: { total: 0 },
              cancelled: { total: 0 },
            },
          },
        },
      }),
      get: vi.fn().mockResolvedValue({
        data: {
          document: {
            documentId: "doc-1",
            bucketId: 7,
            processId: "process-1",
            fileName: "constitution.pdf",
            fileType: "pdf",
            fileSize: "1024",
            sourceUrl: "https://documents.example/constitution.pdf",
            status: "complete",
            statusMessage: "Done",
            xrayUrl: "https://groundx.example/xray/doc-1",
            searchData: { jurisdiction: "GH" },
          },
        },
      }),
    },
    health: {
      list: vi.fn().mockResolvedValue({
        data: {
          health: {
            services: [
              {
                service: "ingest",
                status: "healthy",
                lastUpdate: "2026-07-27T12:00:00Z",
              },
            ],
          },
        },
      }),
    },
  };
}

function makeAdapter(overrides: Record<string, unknown> = {}) {
  return new GroundxAdapter({
    apiKey: "groundx-test-secret",
    sdk: makeSdk(),
    fetch: vi.fn(),
    timeoutMs: 25,
    ...overrides,
  });
}

describe("GroundxAdapter SDK bindings", () => {
  it("creates a bucket through the installed SDK binding and normalizes it", async () => {
    const sdk = makeSdk();
    const adapter = makeAdapter({ sdk });

    await expect(adapter.createBucket({ name: "Ghana statutes" })).resolves.toEqual({
      bucketId: 7,
      name: "Ghana statutes",
    });
    expect(sdk.buckets.create).toHaveBeenCalledWith(
      { name: "Ghana statutes" },
      { timeout: 25 },
    );
  });

  it("ingests remote documents through the SDK and returns a normalized process", async () => {
    const sdk = makeSdk();
    const adapter = makeAdapter({ sdk });
    const documents = [
      {
        bucketId: 7,
        sourceUrl: "https://documents.example/constitution.pdf",
        fileName: "constitution.pdf",
        fileType: "pdf" as const,
        searchData: { jurisdiction: "GH" },
      },
    ];

    await expect(adapter.ingestRemote({ documents })).resolves.toEqual({
      processId: "process-1",
      status: "queued",
    });
    expect(sdk.documents.ingestRemote).toHaveBeenCalledWith(
      { documents },
      { timeout: 25 },
    );
  });

  it("gets normalized process progress through the SDK", async () => {
    const sdk = makeSdk();
    const adapter = makeAdapter({ sdk });

    await expect(adapter.getProcess({ processId: "process-1" })).resolves.toEqual({
      processId: "process-1",
      status: "processing",
      statusMessage: "Indexing",
      progress: { complete: 2, processing: 1, errors: 0, cancelled: 0 },
    });
    expect(sdk.documents.getProcessingStatusById).toHaveBeenCalledWith(
      { processId: "process-1" },
      { timeout: 25 },
    );
  });

  it("deletes documents through the SDK and returns its process", async () => {
    const sdk = makeSdk();
    const adapter = makeAdapter({ sdk });

    await expect(
      adapter.deleteDocuments({ documentIds: ["doc-1", "doc-2"] }),
    ).resolves.toEqual({ processId: "process-1", status: "queued" });
    expect(sdk.documents.delete).toHaveBeenCalledWith(
      { documentIds: ["doc-1", "doc-2"] },
      { timeout: 25 },
    );
  });

  it("returns a narrow normalized document", async () => {
    const sdk = makeSdk();
    const adapter = makeAdapter({ sdk });

    await expect(adapter.getDocument({ documentId: "doc-1" })).resolves.toEqual({
      documentId: "doc-1",
      bucketId: 7,
      processId: "process-1",
      fileName: "constitution.pdf",
      fileType: "pdf",
      fileSize: "1024",
      sourceUrl: "https://documents.example/constitution.pdf",
      status: "complete",
      statusMessage: "Done",
      xrayUrl: "https://groundx.example/xray/doc-1",
      searchData: { jurisdiction: "GH" },
    });
    expect(sdk.documents.get).toHaveBeenCalledWith(
      { documentId: "doc-1" },
      { timeout: 25 },
    );
  });

  it("returns normalized service health through the SDK", async () => {
    const sdk = makeSdk();
    const adapter = makeAdapter({ sdk });

    await expect(adapter.health()).resolves.toEqual({
      services: [
        {
          service: "ingest",
          status: "healthy",
          lastUpdate: "2026-07-27T12:00:00Z",
        },
      ],
    });
    expect(sdk.health.list).toHaveBeenCalledWith({ timeout: 25 });
  });
});

describe("GroundxAdapter copy binding", () => {
  it("calls the missing copy endpoint server-side and normalizes the process", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(ingestResult.data), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const adapter = makeAdapter({ fetch });

    await expect(
      adapter.copyDocuments({
        fromBucket: 1,
        toBucket: 2,
        documentIds: ["doc-1"],
      }),
    ).resolves.toEqual({ processId: "process-1", status: "queued" });

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.groundx.ai/api/v1/ingest/copy");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "X-API-Key": "groundx-test-secret",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      fromBucket: 1,
      toBucket: 2,
      documentIds: ["doc-1"],
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("GroundxAdapter failures", () => {
  it.each([
    [400, "validation", false, "GroundX rejected the request"],
    [422, "validation", false, "GroundX rejected the request"],
    [404, "not_found", false, "GroundX resource was not found"],
    [429, "rate_limit", true, "GroundX rate limit exceeded"],
    [408, "timeout", true, "GroundX request timed out"],
    [503, "provider", true, "GroundX service request failed"],
  ] as const)(
    "maps SDK HTTP %i to %s without exposing provider data",
    async (status, kind, retryable, message) => {
      const sdk = makeSdk();
      sdk.health.list.mockRejectedValue({
        response: { status, data: "groundx-test-secret raw body" },
      });
      const adapter = makeAdapter({ sdk });

      await expect(adapter.health()).rejects.toEqual(
        expect.objectContaining({ kind, retryable, status, message }),
      );
    },
  );

  it.each([
    [400, "validation", false, "GroundX rejected the request"],
    [422, "validation", false, "GroundX rejected the request"],
    [404, "not_found", false, "GroundX resource was not found"],
    [429, "rate_limit", true, "GroundX rate limit exceeded"],
    [504, "timeout", true, "GroundX request timed out"],
    [500, "provider", true, "GroundX service request failed"],
  ] as const)(
    "maps copy HTTP %i to %s without reading provider data",
    async (status, kind, retryable, message) => {
      const text = vi.fn();
      const fetch = vi.fn().mockResolvedValue({ ok: false, status, text });
      const adapter = makeAdapter({ fetch });

      await expect(
        adapter.copyDocuments({ fromBucket: 1, toBucket: 2, documentIds: ["doc-1"] }),
      ).rejects.toEqual(expect.objectContaining({ kind, retryable, status, message }));
      expect(text).not.toHaveBeenCalled();
    },
  );

  it("classifies rate limits without exposing provider response bodies", async () => {
    const secretBody = "provider-debug groundx-test-secret";
    const sdk = makeSdk();
    sdk.health.list.mockRejectedValue({
      response: { status: 429, data: secretBody },
      message: secretBody,
    });
    const adapter = makeAdapter({ sdk });

    const error = await adapter.health().catch((caught: unknown) => caught);

    expect(error).toEqual(
      expect.objectContaining({
        kind: "rate_limit",
        retryable: true,
        status: 429,
        message: "GroundX rate limit exceeded",
      }),
    );
    expect(JSON.stringify(error)).not.toContain(secretBody);
  });

  it("classifies SDK timeouts as retryable and sanitized", async () => {
    const sdk = makeSdk();
    sdk.documents.get.mockRejectedValue({
      code: "ECONNABORTED",
      message: "timeout while using groundx-test-secret",
    });
    const adapter = makeAdapter({ sdk });

    await expect(adapter.getDocument({ documentId: "doc-1" })).rejects.toEqual(
      expect.objectContaining({
        kind: "timeout",
        retryable: true,
        status: null,
        message: "GroundX request timed out",
      }),
    );
  });

  it("classifies network failures as retryable and sanitized", async () => {
    const sdk = makeSdk();
    sdk.buckets.create.mockRejectedValue(
      new Error("DNS failed for groundx-test-secret"),
    );
    const adapter = makeAdapter({ sdk });

    await expect(adapter.createBucket({ name: "Ghana" })).rejects.toEqual(
      expect.objectContaining({
        kind: "network",
        retryable: true,
        status: null,
        message: "GroundX network request failed",
      }),
    );
  });

  it("rejects malformed SDK responses with a typed provider error", async () => {
    const sdk = makeSdk();
    sdk.documents.ingestRemote.mockResolvedValue({
      data: { ingest: { processId: "", status: "surprise" } },
    });
    const adapter = makeAdapter({ sdk });

    await expect(
      adapter.ingestRemote({
        documents: [{ bucketId: 7, sourceUrl: "https://documents.example/law.pdf" }],
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        kind: "invalid_response",
        retryable: false,
        status: null,
        message: "GroundX returned an invalid response",
      }),
    );
  });

  it.each([
    [
      "bucket",
      (sdk: ReturnType<typeof makeSdk>) =>
        sdk.buckets.create.mockResolvedValue({ data: {} }),
      (adapter: GroundxAdapter) => adapter.createBucket({ name: "Ghana" }),
    ],
    [
      "process status",
      (sdk: ReturnType<typeof makeSdk>) =>
        sdk.documents.getProcessingStatusById.mockResolvedValue({
          data: { ingest: { status: "processing" } },
        }),
      (adapter: GroundxAdapter) => adapter.getProcess({ processId: "process-1" }),
    ],
    [
      "document",
      (sdk: ReturnType<typeof makeSdk>) =>
        sdk.documents.get.mockResolvedValue({
          data: { document: { documentId: "" } },
        }),
      (adapter: GroundxAdapter) => adapter.getDocument({ documentId: "doc-1" }),
    ],
    [
      "health",
      (sdk: ReturnType<typeof makeSdk>) =>
        sdk.health.list.mockResolvedValue({
          data: {
            health: {
              services: [
                { service: "ingest", status: "unexpected", lastUpdate: "now" },
              ],
            },
          },
        }),
      (adapter: GroundxAdapter) => adapter.health(),
    ],
  ] as const)("rejects a malformed %s response envelope", async (_family, arrange, act) => {
    const sdk = makeSdk();
    arrange(sdk);
    const adapter = makeAdapter({ sdk });

    await expect(act(adapter)).rejects.toEqual(
      expect.objectContaining({
        kind: "invalid_response",
        retryable: false,
        message: "GroundX returned an invalid response",
      }),
    );
  });

  it("classifies malformed copy JSON as an invalid response", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("not-json", {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const adapter = makeAdapter({ fetch });

    await expect(
      adapter.copyDocuments({ fromBucket: 1, toBucket: 2, documentIds: ["doc-1"] }),
    ).rejects.toEqual(
      expect.objectContaining({
        kind: "invalid_response",
        retryable: false,
        status: 202,
      }),
    );
  });

  it("classifies copy endpoint HTTP failures without reading or exposing the body", async () => {
    const text = vi.fn();
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text,
    });
    const adapter = makeAdapter({ fetch });

    await expect(
      adapter.copyDocuments({ fromBucket: 1, toBucket: 2, documentIds: ["doc-1"] }),
    ).rejects.toEqual(
      expect.objectContaining({
        kind: "provider",
        retryable: true,
        status: 503,
        message: "GroundX service request failed",
      }),
    );
    expect(text).not.toHaveBeenCalled();
  });

  it("classifies an aborted copy request as a retryable timeout", async () => {
    const fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("groundx-test-secret"), { name: "AbortError" }),
    );
    const adapter = makeAdapter({ fetch });

    await expect(
      adapter.copyDocuments({ fromBucket: 1, toBucket: 2, documentIds: ["doc-1"] }),
    ).rejects.toEqual(
      expect.objectContaining({
        kind: "timeout",
        retryable: true,
        status: null,
        message: "GroundX request timed out",
      }),
    );
  });

  it("uses the ProviderError class for every translated failure", async () => {
    const sdk = makeSdk();
    sdk.health.list.mockRejectedValue({ response: { status: 401 } });
    const adapter = makeAdapter({ sdk });

    await expect(adapter.health()).rejects.toBeInstanceOf(ProviderError);
  });

  it("rejects invalid input before calling GroundX", async () => {
    const sdk = makeSdk();
    const adapter = makeAdapter({ sdk });

    await expect(adapter.deleteDocuments({ documentIds: [] })).rejects.toEqual(
      expect.objectContaining({
        kind: "invalid_request",
        retryable: false,
        status: null,
        message: "Invalid GroundX request",
      }),
    );
    expect(sdk.documents.delete).not.toHaveBeenCalled();
  });
});

describe("GroundxAdapter copy timeout lifecycle", () => {
  it("aborts an in-flight copy request when the configured timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      let aborts = 0;
      const fetch = vi.fn((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborts += 1;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
      );
      const adapter = makeAdapter({ fetch, timeoutMs: 25 });

      const result = adapter
        .copyDocuments({ fromBucket: 1, toBucket: 2, documentIds: ["doc-1"] })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(25);

      expect(aborts).toBe(1);
      await expect(result).resolves.toEqual(
        expect.objectContaining({ kind: "timeout", retryable: true }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["success", new Response(JSON.stringify(ingestResult.data), { status: 202 })],
    ["HTTP failure", { ok: false, status: 503 }],
  ])("clears the copy timeout after %s", async (_outcome, response) => {
    vi.useFakeTimers();
    try {
      let lateAborts = 0;
      const fetch = vi.fn((_url: string, init: RequestInit) => {
        init.signal?.addEventListener("abort", () => {
          lateAborts += 1;
        });
        return Promise.resolve(response as Response);
      });
      const adapter = makeAdapter({ fetch, timeoutMs: 25 });

      await adapter
        .copyDocuments({ fromBucket: 1, toBucket: 2, documentIds: ["doc-1"] })
        .catch(() => undefined);
      await vi.advanceTimersByTimeAsync(25);

      expect(lateAborts).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
