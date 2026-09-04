import { GoogleGenAI, UploadToFileSearchStoreOperation } from "@google/genai";
import { z } from "zod";
import {
  isGeminiDocumentName,
  isGeminiFileSearchStoreName,
  isGeminiUploadOperationForStore,
  parseGeminiUploadOperationName,
} from "../../lib/geminiFileSearchNames";

export { isGeminiUploadOperationForStore } from "../../lib/geminiFileSearchNames";

const EMBEDDING_MODEL = "models/gemini-embedding-2";
const storeNameSchema = z.string().refine(isGeminiFileSearchStoreName);
const documentNameSchema = z.string().refine(isGeminiDocumentName);
const operationNameSchema = z.string().refine((value) => parseGeminiUploadOperationName(value) !== null);
const completedOperationErrorSchema = z.object({
  code: z.number().int().min(1).max(16),
  message: z.string().trim().min(1).max(1_024),
}).strict();
const metadataSchema = z.object({
  key: z.string().trim().min(1).max(64),
  stringValue: z.string().max(1_024).optional(),
  numericValue: z.number().finite().optional(),
}).refine((value) => (value.stringValue === undefined) !== (value.numericValue === undefined));

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

export type ProviderOperation =
  | "store_create"
  | "document_upload"
  | "operation_poll"
  | "store_get"
  | "document_delete"
  | "store_delete";

export class ProviderError extends Error {
  readonly name = "ProviderError";

  constructor(
    public readonly kind: ProviderErrorKind,
    public readonly retryable: boolean,
    public readonly status: number | null,
    message: string,
    /** True only when a mutating request may have reached Gemini. */
    public readonly sideEffectUncertain = false,
    /** A bounded internal request label, never a provider resource name. */
    public readonly operation?: ProviderOperation,
    /** The provider response body, retained temporarily for an authorized diagnostic view. */
    public readonly rawResponse?: string,
  ) {
    super(message);
  }
}

export type GeminiFileSearchSdk = {
  fileSearchStores: {
    create(request: { config: { displayName: string; embeddingModel: string } }): Promise<{
      name?: string;
      embeddingModel?: string;
    }>;
    get(request: { name: string }): Promise<{ name?: string; embeddingModel?: string }>;
    delete(request: { name: string; config: { force: boolean } }): Promise<void>;
    uploadToFileSearchStore(request: {
      fileSearchStoreName: string;
      file: Blob;
      config: { mimeType: string; displayName: string; customMetadata: Array<{ key: string; stringValue?: string; numericValue?: number }> };
    }): Promise<{ name?: string }>;
    documents: { delete(request: { name: string; config: { force: boolean } }): Promise<void> };
  };
  operations: {
    get(request: { operation: UploadToFileSearchStoreOperation }): Promise<{
      name?: string;
      done?: boolean;
      error?: unknown;
      response?: { documentName?: unknown };
    }>;
  };
};

export interface GeminiFileSearchAdapterOptions {
  apiKey: string;
  sdk?: GeminiFileSearchSdk;
}

function defaultSdk(apiKey: string): GeminiFileSearchSdk {
  const client = new GoogleGenAI({ apiKey });
  return {
    fileSearchStores: {
      create: async (request) => await client.fileSearchStores.create(request),
      get: async (request) => await client.fileSearchStores.get(request),
      delete: async (request) => await client.fileSearchStores.delete(request),
      uploadToFileSearchStore: async (request) => await client.fileSearchStores.uploadToFileSearchStore(request),
      documents: { delete: async (request) => await client.fileSearchStores.documents.delete(request) },
    },
    operations: {
      get: async ({ operation }) => {
        const response = await client.operations.get({ operation: operation as never });
        return {
          name: response.name,
          done: response.done,
          error: response.error,
          response: typeof response.response === "object" && response.response !== null
            ? { documentName: (response.response as { documentName?: unknown }).documentName }
            : undefined,
        };
      },
    },
  };
}

function invalidRequest(): ProviderError {
  return new ProviderError("invalid_request", false, null, "Invalid Gemini File Search request");
}

function invalidResponse(sideEffectUncertain = false): ProviderError {
  return new ProviderError("invalid_response", false, null, "Gemini returned an invalid response", sideEffectUncertain);
}

function errorForStatus(status: number): ProviderError {
  if (status === 400 || status === 422) return new ProviderError("validation", false, status, "Gemini rejected the request");
  if (status === 401 || status === 403) return new ProviderError("authentication", false, status, "Gemini authentication failed");
  if (status === 404) return new ProviderError("not_found", false, status, "Gemini resource was not found");
  if (status === 429) return new ProviderError("rate_limit", true, status, "Gemini request was rate limited");
  if (status === 408 || status === 504) return new ProviderError("timeout", true, status, "Gemini request timed out");
  return new ProviderError("provider", status >= 500, status, "Gemini service request failed");
}

function errorForRpcCode(code: number): ProviderError {
  if (code === 3 || code === 9 || code === 11) return new ProviderError("validation", false, code, "Gemini rejected the indexed document");
  if (code === 7 || code === 16) return new ProviderError("authentication", false, code, "Gemini authentication failed");
  if (code === 5) return new ProviderError("not_found", false, code, "Gemini operation was not found");
  if (code === 8) return new ProviderError("rate_limit", true, code, "Gemini operation was rate limited");
  if (code === 4) return new ProviderError("timeout", true, code, "Gemini operation timed out");
  return new ProviderError("provider", code === 13 || code === 14, code, "Gemini indexing operation failed");
}

function translateError(
  error: unknown,
  sideEffectUncertain = false,
  operation?: ProviderOperation,
): ProviderError {
  if (error instanceof ProviderError) return error;
  const rawResponse = rawProviderResponse(error);
  if (typeof error === "object" && error !== null) {
    const candidate = error as { name?: unknown; code?: unknown; status?: unknown; error?: { code?: unknown } };
    if (candidate.name === "AbortError" || candidate.code === "ECONNABORTED" || candidate.code === "ERR_CANCELED") {
      return new ProviderError("timeout", true, null, "Gemini request timed out", sideEffectUncertain, operation, rawResponse);
    }
    const status = typeof candidate.status === "number"
      ? candidate.status
      : typeof candidate.code === "number"
        ? candidate.code
        : typeof candidate.error?.code === "number" ? candidate.error.code : null;
    if (status !== null) {
      const translated = errorForStatus(status);
      const mutationMayBeAmbiguous = sideEffectUncertain &&
        (status === 408 || status === 504 || status >= 500);
      return new ProviderError(translated.kind, translated.retryable, translated.status, translated.message, mutationMayBeAmbiguous, operation, rawResponse);
    }
  }
  return new ProviderError("network", true, null, "Gemini network request failed", sideEffectUncertain, operation, rawResponse);
}

function rawProviderResponse(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || undefined;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return error === undefined ? undefined : String(error);
}

function valid<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidRequest();
  return parsed.data;
}

export class GeminiFileSearchAdapter {
  private readonly sdk: GeminiFileSearchSdk;

  constructor(options: GeminiFileSearchAdapterOptions) {
    const apiKey = z.string().trim().min(1).safeParse(options.apiKey);
    if (!apiKey.success) throw invalidRequest();
    this.sdk = options.sdk ?? defaultSdk(apiKey.data);
  }

  async createStore(input: { displayName: string; embeddingModel: "models/gemini-embedding-2" }): Promise<{ name: string; embeddingModel: string }> {
    const displayName = valid(z.string().trim().min(1).max(200), input.displayName);
    if (input.embeddingModel !== EMBEDDING_MODEL) throw invalidRequest();
    try {
      const response = await this.sdk.fileSearchStores.create({
        config: { displayName, embeddingModel: input.embeddingModel },
      });
      const name = storeNameSchema.safeParse(response.name);
      if (!name.success || response.embeddingModel !== EMBEDDING_MODEL) throw invalidResponse(true);
      return { name: name.data, embeddingModel: EMBEDDING_MODEL };
    } catch (error) {
      throw translateError(error, true, "store_create");
    }
  }

  async uploadDocument(input: {
    storeName: string;
    file: Blob;
    mimeType: string;
    displayName: string;
    customMetadata: Array<{ key: string; stringValue: string } | { key: string; numericValue: number }>;
  }): Promise<{ operationName: string }> {
    const storeName = valid(storeNameSchema, input.storeName);
    const mimeType = valid(z.string().trim().min(1).max(200), input.mimeType);
    const displayName = valid(z.string().trim().min(1).max(512), input.displayName);
    const customMetadata = valid(z.array(metadataSchema).max(20), input.customMetadata);
    if (!(input.file instanceof Blob)) throw invalidRequest();
    try {
      const response = await this.sdk.fileSearchStores.uploadToFileSearchStore({
        fileSearchStoreName: storeName,
        file: input.file,
        config: { mimeType, displayName, customMetadata },
      });
      const operationName = operationNameSchema.safeParse(response.name);
      if (!operationName.success || !isGeminiUploadOperationForStore(operationName.data, storeName)) throw invalidResponse(true);
      return { operationName: operationName.data };
    } catch (error) {
      throw translateError(error, true, "document_upload");
    }
  }

  async getIndexOperation(operationName: string): Promise<
    | { done: false }
    | { done: true; documentName: string }
    | { done: true; error: { kind: ProviderErrorKind; retryable: boolean; message: string } }
  > {
    const name = valid(operationNameSchema, operationName);
    try {
      const operation = new UploadToFileSearchStoreOperation();
      operation.name = name;
      const response = await this.sdk.operations.get({ operation });
      if (response.name !== name || typeof response.done !== "boolean") throw invalidResponse();
      if (!response.done) return { done: false };
      if (response.error !== undefined) {
        if (response.response !== undefined) throw invalidResponse();
        const parsed = completedOperationErrorSchema.safeParse(response.error);
        if (!parsed.success) throw invalidResponse();
        const error = errorForRpcCode(parsed.data.code);
        return { done: true, error: { kind: error.kind, retryable: error.retryable, message: error.message } };
      }
      const documentName = documentNameSchema.safeParse(response.response?.documentName);
      if (!documentName.success) throw invalidResponse();
      return { done: true, documentName: documentName.data };
    } catch (error) {
      throw translateError(error, false, "operation_poll");
    }
  }

  async getStore(storeName: string): Promise<{ name: string; embeddingModel: string }> {
    const name = valid(storeNameSchema, storeName);
    try {
      const response = await this.sdk.fileSearchStores.get({ name });
      const responseName = storeNameSchema.safeParse(response.name);
      if (
        !responseName.success
        || responseName.data !== name
        || response.embeddingModel !== EMBEDDING_MODEL
      ) throw invalidResponse();
      return { name: responseName.data, embeddingModel: EMBEDDING_MODEL };
    } catch (error) {
      throw translateError(error, false, "store_get");
    }
  }

  async deleteDocument(documentName: string): Promise<void> {
    const name = valid(documentNameSchema, documentName);
    try {
      await this.sdk.fileSearchStores.documents.delete({ name, config: { force: true } });
    } catch (error) {
      throw translateError(error, true, "document_delete");
    }
  }

  async deleteStore(storeName: string): Promise<void> {
    const name = valid(storeNameSchema, storeName);
    try {
      await this.sdk.fileSearchStores.delete({ name, config: { force: true } });
    } catch (error) {
      throw translateError(error, true, "store_delete");
    }
  }
}
