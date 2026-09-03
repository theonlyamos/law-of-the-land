"use node";

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import { GEMINI_DOCUMENT_TYPES } from "../../shared/gemini-file-types";
import { resolveE2EProviderIsolation } from "./e2eProviderIsolation";
import {
  GeminiFileSearchAdapter,
  ProviderError,
  isGeminiUploadOperationForStore,
  type ProviderErrorKind,
} from "./integrations/geminiFileSearch";

const PROVIDER_MAX_DOCUMENT_BYTES = 100_000_000;

const getJobRef = makeFunctionReference<"query">("admin/jobs:getJobForRun");
const claimJobRef = makeFunctionReference<"mutation">("admin/jobs:claimJob");
const deferUnstartedPublicationJobRef = makeFunctionReference<"mutation">("admin/jobs:deferUnstartedPublicationJob");
const targetRef = makeFunctionReference<"query">("admin/jobs:getGeminiJobTarget");
const resultRef = makeFunctionReference<"mutation">("admin/jobs:applyGeminiProviderResult");
const failureRef = makeFunctionReference<"mutation">("admin/jobs:recordProviderFailure");
const consumeE2EProviderOutcomeRef = makeFunctionReference<"mutation">("admin/e2eFixtures:consumeProviderOutcome");

type Adapter = Pick<
  GeminiFileSearchAdapter,
  "createStore" | "uploadDocument" | "getIndexOperation" | "deleteDocument" | "deleteStore"
>;

export type GeminiExecutionJob = {
  type: "gemini_create_store" | "gemini_index_document" | "gemini_delete_document" | "gemini_delete_store";
  providerOperationName?: string;
};

export type GeminiExecutionTarget =
  | {
      kind: "create_store";
      displayName: string;
      embeddingModel: "models/gemini-embedding-2";
    }
  | {
      kind: "index_document";
      signedUrl?: string;
      byteSize: number;
      storeName: string;
      mimeType: string;
      displayName: string;
      customMetadata: Array<{ key: string; stringValue: string }>;
    }
  | { kind: "delete_document"; documentName: string }
  | { kind: "delete_store"; storeName: string };

export type GeminiExecutionResult =
  | { kind: "store_created"; storeName: string; embeddingModel: string }
  | { kind: "index_accepted"; operationName: string }
  | { kind: "index_pending" }
  | { kind: "index_completed"; documentName: string }
  | { kind: "index_failed"; errorKind: ProviderErrorKind }
  | { kind: "document_deleted" }
  | { kind: "store_deleted"; storeName: string };

type KnownStoreResult = Extract<
  GeminiExecutionResult,
  { kind: "store_created" } | { kind: "store_deleted" }
>;

type PersistenceFailure = {
  kind: ProviderErrorKind;
  retryable: boolean;
  sideEffectUncertain: boolean;
  providerOperationName?: string;
  knownStoreResult?: KnownStoreResult;
};

export async function persistGeminiProviderResult(input: {
  result: GeminiExecutionResult;
  persist: () => Promise<void>;
  failure: (failure: PersistenceFailure) => Promise<void>;
}): Promise<"persisted" | "manual_review"> {
  try {
    await input.persist();
    return "persisted";
  } catch {
    const failure: PersistenceFailure = {
      kind: "invalid_response",
      retryable: false,
      sideEffectUncertain: true,
      ...(input.result.kind === "index_accepted"
        ? { providerOperationName: input.result.operationName }
        : {}),
      ...(input.result.kind === "store_created" || input.result.kind === "store_deleted"
        ? { knownStoreResult: input.result }
        : {}),
    };
    try {
      await input.failure(failure);
    } catch {
      // The provider effect is known, but neither durable write is available.
      // Do not turn this into a provider failure or replay the mutation.
    }
    return "manual_review";
  }
}

function invalidExecution(): ProviderError {
  return new ProviderError("invalid_request", false, null, "Invalid Gemini durable job");
}

function documentTooLarge(): ProviderError {
  return new ProviderError("validation", false, null, "DOCUMENT_TOO_LARGE");
}

export async function executeGeminiJob(
  adapter: Adapter,
  job: GeminiExecutionJob,
  target: GeminiExecutionTarget,
  options: {
    fetcher?: typeof fetch;
    maxDocumentBytes?: number;
  },
): Promise<GeminiExecutionResult> {
  if (job.type === "gemini_create_store" && target.kind === "create_store") {
    const created = await adapter.createStore({
      displayName: target.displayName,
      embeddingModel: target.embeddingModel,
    });
    return {
      kind: "store_created",
      storeName: created.name,
      embeddingModel: created.embeddingModel,
    };
  }
  if (job.type === "gemini_delete_document" && target.kind === "delete_document") {
    try {
      await adapter.deleteDocument(target.documentName);
    } catch (error) {
      if (!(error instanceof ProviderError) || error.kind !== "not_found") throw error;
    }
    return { kind: "document_deleted" };
  }
  if (job.type === "gemini_delete_store" && target.kind === "delete_store") {
    try {
      await adapter.deleteStore(target.storeName);
    } catch (error) {
      if (!(error instanceof ProviderError) || error.kind !== "not_found") throw error;
    }
    return { kind: "store_deleted", storeName: target.storeName };
  }
  if (job.type !== "gemini_index_document" || target.kind !== "index_document") {
    throw invalidExecution();
  }
  if (job.providerOperationName) {
    if (!isGeminiUploadOperationForStore(job.providerOperationName, target.storeName)) throw invalidExecution();
    const operation = await adapter.getIndexOperation(job.providerOperationName);
    if (!operation.done) return { kind: "index_pending" };
    if ("error" in operation) {
      return { kind: "index_failed", errorKind: operation.error.kind };
    }
    return { kind: "index_completed", documentName: operation.documentName };
  }
  const separator = target.displayName.lastIndexOf(".");
  const extension = separator < 1 ? "" : target.displayName.slice(separator + 1).toLowerCase();
  const allowedMimes = GEMINI_DOCUMENT_TYPES[extension as keyof typeof GEMINI_DOCUMENT_TYPES] as readonly string[] | undefined;
  if (!allowedMimes?.includes(target.mimeType)) throw invalidExecution();
  if (
    !Number.isSafeInteger(options.maxDocumentBytes) ||
    options.maxDocumentBytes === undefined ||
    options.maxDocumentBytes < 1 ||
    !Number.isSafeInteger(target.byteSize) ||
    target.byteSize < 0 ||
    target.byteSize > options.maxDocumentBytes
  ) throw documentTooLarge();

  if (!target.signedUrl) throw invalidExecution();

  const response = await (options.fetcher ?? fetch)(target.signedUrl, {
    method: "GET",
    redirect: "error",
  });
  if (!response.ok) {
    throw new ProviderError("network", true, response.status, "Convex original could not be fetched");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > options.maxDocumentBytes) {
      throw documentTooLarge();
    }
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > options.maxDocumentBytes || bytes.byteLength !== target.byteSize) {
    throw documentTooLarge();
  }
  const file = new Blob([bytes], { type: target.mimeType });
  const accepted = await adapter.uploadDocument({
    storeName: target.storeName,
    file,
    mimeType: target.mimeType,
    displayName: target.displayName,
    customMetadata: target.customMetadata,
  });
  return { kind: "index_accepted", operationName: accepted.operationName };
}

function configuredMaxDocumentBytes(): number {
  const raw = process.env.ADMIN_MAX_DOCUMENT_BYTES;
  if (!raw || !/^\d+$/.test(raw)) throw new ProviderError(
    "validation",
    false,
    null,
    "Document upload limit is not configured",
  );
  const configured = Number(raw);
  if (!Number.isSafeInteger(configured) || configured < 1) throw invalidExecution();
  return Math.min(configured, PROVIDER_MAX_DOCUMENT_BYTES);
}

export function executionOptionsForJob(job: GeminiExecutionJob): { maxDocumentBytes?: number } {
  return job.type === "gemini_index_document" && job.providerOperationName === undefined
    ? { maxDocumentBytes: configuredMaxDocumentBytes() }
    : {};
}

async function stubResourceId(jobId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(jobId));
  return Array.from(new Uint8Array(digest).slice(0, 10), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function stubGeminiResult(
  jobId: string,
  job: GeminiExecutionJob,
  target: GeminiExecutionTarget,
): Promise<GeminiExecutionResult> {
  const suffix = await stubResourceId(jobId);
  if (job.type === "gemini_create_store" && target.kind === "create_store") {
    return { kind: "store_created", storeName: `fileSearchStores/e2e-${suffix}`, embeddingModel: target.embeddingModel };
  }
  if (job.type === "gemini_delete_store" && target.kind === "delete_store") {
    return { kind: "store_deleted", storeName: target.storeName };
  }
  if (job.type === "gemini_delete_document" && target.kind === "delete_document") {
    return { kind: "document_deleted" };
  }
  if (job.type === "gemini_index_document" && target.kind === "index_document") {
    return job.providerOperationName
      ? { kind: "index_completed", documentName: `${target.storeName}/documents/e2e-${suffix}` }
      : { kind: "index_accepted", operationName: `${target.storeName}/upload/operations/e2e-${suffix}` };
  }
  throw invalidExecution();
}

export const runGeminiJob = internalAction({
  args: {
    jobId: v.id("integrationJobs"),
    leaseToken: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const claim = args.leaseToken
      ? ((await ctx.runQuery(getJobRef, {
          jobId: args.jobId,
          leaseToken: args.leaseToken,
        })) as Doc<"integrationJobs"> | null)
      : ((await ctx.runMutation(claimJobRef, { jobId: args.jobId })) as {
          leaseToken: string;
          job: Doc<"integrationJobs">;
        } | null);
    if (!claim) return null;
    const leaseToken = args.leaseToken ?? (claim as { leaseToken: string }).leaseToken;
    const job = args.leaseToken
      ? (claim as Doc<"integrationJobs">)
      : (claim as { job: Doc<"integrationJobs"> }).job;
    if (job.recoveryKind === "apply_store_result" && job.knownStoreResult !== undefined) {
      const result = job.knownStoreResult as KnownStoreResult;
      await persistGeminiProviderResult({
        result,
        persist: async () => {
          await ctx.runMutation(resultRef, { jobId: args.jobId, leaseToken, result });
        },
        failure: async (failure) => {
          await ctx.runMutation(failureRef, { jobId: args.jobId, leaseToken, ...failure });
        },
      });
      return null;
    }
    let target: GeminiExecutionTarget | null;
    try {
      target = (await ctx.runQuery(targetRef, {
        jobId: args.jobId,
        leaseToken,
      })) as GeminiExecutionTarget | null;
    } catch {
      const deferred = await ctx.runMutation(deferUnstartedPublicationJobRef, {
        jobId: args.jobId,
        leaseToken,
      }) as boolean;
      if (deferred) return null;
      await ctx.runMutation(failureRef, {
        jobId: args.jobId,
        leaseToken,
        kind: "invalid_response",
        retryable: false,
        sideEffectUncertain: false,
      });
      return null;
    }
    if (!target) return null;
    const executionJob: GeminiExecutionJob = {
      type: job.type as GeminiExecutionJob["type"],
      ...(job.providerOperationName === undefined
        ? {}
        : { providerOperationName: job.providerOperationName }),
    };
    let result: GeminiExecutionResult;
    if (resolveE2EProviderIsolation() === "stub") {
      const outcome = await ctx.runMutation(consumeE2EProviderOutcomeRef, { jobId: args.jobId }) as "succeeded" | "failed";
      if (outcome === "failed") {
        await ctx.runMutation(failureRef, {
          jobId: args.jobId,
          leaseToken,
          kind: "provider",
          retryable: false,
          sideEffectUncertain: false,
        });
        return null;
      }
      result = await stubGeminiResult(job._id, executionJob, target);
      await ctx.runMutation(resultRef, { jobId: args.jobId, leaseToken, result });
      return null;
    }
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      await ctx.runMutation(failureRef, {
        jobId: args.jobId,
        leaseToken,
        kind: "authentication",
        retryable: false,
        sideEffectUncertain: false,
      });
      return null;
    }
    try {
      result = await executeGeminiJob(
        new GeminiFileSearchAdapter({ apiKey }),
        executionJob,
        target,
        executionOptionsForJob(executionJob),
      );
    } catch (error) {
      const kind: ProviderErrorKind = error instanceof ProviderError
        ? error.kind
        : "invalid_response";
      await ctx.runMutation(failureRef, {
        jobId: args.jobId,
        leaseToken,
        kind,
        retryable: error instanceof ProviderError ? error.retryable : false,
        sideEffectUncertain: error instanceof ProviderError
          ? error.sideEffectUncertain === true
          : false,
      });
      return null;
    }
    await persistGeminiProviderResult({
      result,
      persist: async () => {
        await ctx.runMutation(resultRef, { jobId: args.jobId, leaseToken, result });
      },
      failure: async (failure) => {
        await ctx.runMutation(failureRef, { jobId: args.jobId, leaseToken, ...failure });
      },
    });
    return null;
  },
});
