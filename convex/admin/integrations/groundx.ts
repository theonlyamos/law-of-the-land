import { Groundx } from "groundx-typescript-sdk";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 10_000;
const COPY_ENDPOINT = "https://api.groundx.ai/api/v1/ingest/copy";
const REMOTE_INGEST_ENDPOINT = "https://api.groundx.ai/api/v1/ingest/documents/remote";

const processingStatusSchema = z.enum([
  "queued",
  "training",
  "processing",
  "error",
  "complete",
  "cancelled",
]);
const documentTypeSchema = z.enum([
  "txt",
  "docx",
  "pptx",
  "xlsx",
  "pdf",
  "png",
  "jpg",
  "csv",
  "tsv",
  "json",
]);

const processSchema = z.object({
  processId: z.string().min(1),
  status: processingStatusSchema,
});

const sdkProcessEnvelopeSchema = z.object({
  data: z.object({
    ingest: processSchema,
  }),
});

const rawProcessEnvelopeSchema = z.object({ ingest: processSchema });

const bucketEnvelopeSchema = z.object({
  data: z.object({
    bucket: z.object({
      bucketId: z.number().int().positive(),
      name: z.string().min(1).optional(),
    }),
  }),
});

const progressDocumentSchema = z.object({
  documentId: z.string().min(1),
  bucketId: z.number().int().positive().optional(),
  processId: z.string().min(1).optional(),
  fileName: z.string().min(1).optional(),
  fileType: documentTypeSchema.optional(),
  fileSize: z.string().optional(),
  sourceUrl: z.string().url().optional(),
  status: processingStatusSchema.optional(),
  statusMessage: z.string().optional(),
});
const progressPartSchema = z.object({
  documents: z.array(progressDocumentSchema).optional(),
  total: z.number().int().nonnegative().optional(),
});
const processStatusSchema = processSchema.extend({
  statusMessage: z.string().optional(),
  progress: z.object({
    complete: progressPartSchema.optional(),
    processing: progressPartSchema.optional(),
    errors: progressPartSchema.optional(),
    cancelled: progressPartSchema.optional(),
  }).optional(),
});
const processStatusEnvelopeSchema = z.object({
  data: z.object({
    ingest: processStatusSchema,
  }),
});
const rawProcessStatusEnvelopeSchema = z.object({ ingest: processStatusSchema });

const searchDataSchema = z.record(z.string(), z.unknown());
const documentEnvelopeSchema = z.object({
  data: z.object({
    document: z.object({
      documentId: z.string().min(1),
      bucketId: z.number().int().positive().optional(),
      processId: z.string().min(1).optional(),
      fileName: z.string().min(1).optional(),
      fileType: documentTypeSchema.optional(),
      fileSize: z.string().optional(),
      sourceUrl: z.string().url().optional(),
      status: processingStatusSchema.optional(),
      statusMessage: z.string().optional(),
      xrayUrl: z.string().url().optional(),
      searchData: searchDataSchema.optional(),
    }),
  }),
});

const healthEnvelopeSchema = z.object({
  data: z.object({
    health: z.object({
      services: z.array(
        z.object({
          service: z.string().min(1),
          status: z.enum(["healthy", "degraded", "down", "unknown"]),
          lastUpdate: z.string().min(1),
        }),
      ),
    }),
  }),
});

const createBucketInputSchema = z.object({ name: z.string().trim().min(1).max(200) });
const documentIdInputSchema = z.object({ documentId: z.string().trim().min(1) });
const processIdInputSchema = z.object({ processId: z.string().trim().min(1) });
const documentIdsInputSchema = z.object({
  documentIds: z.array(z.string().trim().min(1)).min(1).max(100),
});
const remoteDocumentSchema = z.object({
  bucketId: z.number().int().positive(),
  sourceUrl: z.string().url(),
  fileName: z.string().min(1).optional(),
  fileType: documentTypeSchema.optional(),
  searchData: searchDataSchema.optional(),
});
const ingestRemoteInputSchema = z.object({
  documents: z.array(remoteDocumentSchema).min(1).max(100),
  callbackUrl: z.string().url().optional(),
  callbackData: z.string().min(1).max(256).optional(),
});
const copyDocumentsInputSchema = documentIdsInputSchema.extend({
  fromBucket: z.number().int().positive(),
  toBucket: z.number().int().positive(),
});

export type ProviderErrorKind =
  | "invalid_request"
  | "validation"
  | "authentication"
  | "not_found"
  | "rate_limit"
  | "timeout"
  | "network"
  | "invalid_response"
  | "provider";

export class ProviderError extends Error {
  readonly name = "ProviderError";

  constructor(
    public readonly kind: ProviderErrorKind,
    public readonly retryable: boolean,
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

type SdkResponse = Promise<{ data: unknown }>;
type SdkOptions = { timeout: number };

export interface GroundxSdk {
  buckets: {
    create(input: { name: string }, options?: SdkOptions): SdkResponse;
  };
  documents: {
    ingestRemote(input: { documents: RemoteDocument[] }, options?: SdkOptions): SdkResponse;
    delete(input: { documentIds: string[] }, options?: SdkOptions): SdkResponse;
    getProcessingStatusById(
      input: { processId: string },
      options?: SdkOptions,
    ): SdkResponse;
    get(input: { documentId: string }, options?: SdkOptions): SdkResponse;
  };
  health: {
    list(options?: SdkOptions): SdkResponse;
  };
}

export type RemoteDocument = z.infer<typeof remoteDocumentSchema>;
export type NormalizedProcess = {
  processId: string;
  status: z.infer<typeof processingStatusSchema>;
  statusMessage?: string | null;
  progress?: { complete: number; processing: number; errors: number; cancelled: number } | null;
  completedDocuments?: Array<z.infer<typeof progressDocumentSchema>>;
};
export type NormalizedDocument = z.infer<typeof documentEnvelopeSchema>["data"]["document"];
export type NormalizedHealth = z.infer<typeof healthEnvelopeSchema>["data"]["health"];

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GroundxAdapterOptions {
  apiKey: string;
  sdk?: GroundxSdk;
  fetch?: FetchLike;
  timeoutMs?: number;
}

function invalidRequest(): ProviderError {
  return new ProviderError("invalid_request", false, null, "Invalid GroundX request");
}

function invalidResponse(status: number | null = null): ProviderError {
  return new ProviderError(
    "invalid_response",
    false,
    status,
    "GroundX returned an invalid response",
  );
}

function errorForStatus(status: number): ProviderError {
  if (status === 400 || status === 422) {
    return new ProviderError("validation", false, status, "GroundX rejected the request");
  }
  if (status === 401 || status === 403) {
    return new ProviderError("authentication", false, status, "GroundX authentication failed");
  }
  if (status === 404) {
    return new ProviderError("not_found", false, status, "GroundX resource was not found");
  }
  if (status === 429) {
    return new ProviderError("rate_limit", true, status, "GroundX rate limit exceeded");
  }
  if (status === 408 || status === 504) {
    return new ProviderError("timeout", true, status, "GroundX request timed out");
  }
  return new ProviderError(
    "provider",
    status >= 500,
    status,
    "GroundX service request failed",
  );
}

function translateError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;

  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      name?: unknown;
      code?: unknown;
      response?: { status?: unknown };
    };
    if (
      candidate.name === "AbortError" ||
      candidate.code === "ECONNABORTED" ||
      candidate.code === "ERR_CANCELED"
    ) {
      return new ProviderError("timeout", true, null, "GroundX request timed out");
    }
    if (typeof candidate.response?.status === "number") {
      return errorForStatus(candidate.response.status);
    }
  }

  return new ProviderError("network", true, null, "GroundX network request failed");
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalidRequest();
  return parsed.data;
}

function parseResponse<T>(schema: z.ZodType<T>, input: unknown, status?: number): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalidResponse(status ?? null);
  return parsed.data;
}

function normalizeProcess(input: z.infer<typeof processStatusSchema>): NormalizedProcess {
  const progress = input.progress;
  return {
    processId: input.processId,
    status: input.status,
    ...(input.statusMessage !== undefined ? { statusMessage: input.statusMessage } : {}),
    ...(progress ? { progress: {
          complete: progress.complete?.total ?? 0,
          processing: progress.processing?.total ?? 0,
          errors: progress.errors?.total ?? 0,
          cancelled: progress.cancelled?.total ?? 0,
        } } : {}),
    ...(progress?.complete?.documents?.length
      ? { completedDocuments: progress.complete.documents }
      : {}),
  };
}

export class GroundxAdapter {
  private readonly apiKey: string;
  private readonly sdk: GroundxSdk;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: GroundxAdapterOptions) {
    const apiKey = z.string().trim().min(1).safeParse(options.apiKey);
    if (!apiKey.success) throw invalidRequest();
    if (!Number.isFinite(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) || (options.timeoutMs ?? 1) <= 0) {
      throw invalidRequest();
    }

    this.apiKey = apiKey.data;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sdk = options.sdk ?? (new Groundx({ apiKey: this.apiKey }) as GroundxSdk);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async createBucket(input: { name: string }): Promise<{ bucketId: number; name: string | null }> {
    const request = parseInput(createBucketInputSchema, input);
    try {
      const response = parseResponse(
        bucketEnvelopeSchema,
        await this.sdk.buckets.create(request, { timeout: this.timeoutMs }),
      );
      return {
        bucketId: response.data.bucket.bucketId,
        name: response.data.bucket.name ?? null,
      };
    } catch (error) {
      throw translateError(error);
    }
  }

  async ingestRemote(input: {
    documents: RemoteDocument[];
    callbackUrl?: string;
    callbackData?: string;
  }): Promise<NormalizedProcess> {
    const request = parseInput(ingestRemoteInputSchema, input);
    if (request.callbackUrl !== undefined) {
      if (request.callbackData === undefined) throw invalidRequest();
      return await this.postRemoteIngestWithCallback(request);
    }
    try {
      const response = parseResponse(
        sdkProcessEnvelopeSchema,
        await this.sdk.documents.ingestRemote(
          { documents: request.documents },
          { timeout: this.timeoutMs },
        ),
      );
      return response.data.ingest;
    } catch (error) {
      throw translateError(error);
    }
  }

  private async postRemoteIngestWithCallback(input: z.infer<typeof ingestRemoteInputSchema>): Promise<NormalizedProcess> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(REMOTE_INGEST_ENDPOINT, {
        method: "POST",
        headers: {
          "X-API-Key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (!response.ok) throw errorForStatus(response.status);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw invalidResponse(response.status);
      }
      return parseResponse(rawProcessEnvelopeSchema, body, response.status).ingest;
    } catch (error) {
      throw translateError(error);
    } finally {
      clearTimeout(timeout);
    }
  }

  async copyDocuments(input: {
    fromBucket: number;
    toBucket: number;
    documentIds: string[];
  }): Promise<NormalizedProcess> {
    const request = parseInput(copyDocumentsInputSchema, input);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(COPY_ENDPOINT, {
        method: "POST",
        headers: {
          "X-API-Key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) throw errorForStatus(response.status);

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw invalidResponse(response.status);
      }
      return normalizeProcess(parseResponse(rawProcessStatusEnvelopeSchema, body, response.status).ingest);
    } catch (error) {
      throw translateError(error);
    } finally {
      clearTimeout(timeout);
    }
  }

  async getProcess(input: { processId: string }): Promise<NormalizedProcess> {
    const request = parseInput(processIdInputSchema, input);
    try {
      const response = parseResponse(
        processStatusEnvelopeSchema,
        await this.sdk.documents.getProcessingStatusById(request, { timeout: this.timeoutMs }),
      ).data.ingest;
      return normalizeProcess(response);
    } catch (error) {
      throw translateError(error);
    }
  }

  async deleteDocuments(input: { documentIds: string[] }): Promise<NormalizedProcess> {
    const request = parseInput(documentIdsInputSchema, input);
    try {
      const response = parseResponse(
        sdkProcessEnvelopeSchema,
        await this.sdk.documents.delete(request, { timeout: this.timeoutMs }),
      );
      return response.data.ingest;
    } catch (error) {
      throw translateError(error);
    }
  }

  async getDocument(input: { documentId: string }): Promise<NormalizedDocument> {
    const request = parseInput(documentIdInputSchema, input);
    try {
      const response = parseResponse(
        documentEnvelopeSchema,
        await this.sdk.documents.get(request, { timeout: this.timeoutMs }),
      );
      return response.data.document;
    } catch (error) {
      throw translateError(error);
    }
  }

  async health(): Promise<NormalizedHealth> {
    try {
      const response = parseResponse(
        healthEnvelopeSchema,
        await this.sdk.health.list({ timeout: this.timeoutMs }),
      );
      return response.data.health;
    } catch (error) {
      throw translateError(error);
    }
  }
}
