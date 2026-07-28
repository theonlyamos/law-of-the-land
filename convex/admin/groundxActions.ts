"use node";

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { z } from "zod";
import type { Doc } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import { GroundxAdapter, ProviderError } from "./integrations/groundx";
import { resolveE2EProviderIsolation } from "./e2eProviderIsolation";

const getJobRef = makeFunctionReference<"query">("admin/jobs:getJobForRun");
const claimJobRef = makeFunctionReference<"mutation">("admin/jobs:claimJob");
const resultRef = makeFunctionReference<"mutation">("admin/jobs:applyProviderResult");
const failureRef = makeFunctionReference<"mutation">("admin/jobs:recordProviderFailure");
const evidenceTargetRef = makeFunctionReference<"query">("admin/documents:getStagingEvidenceTarget");
const consumeE2EProviderOutcomeRef = makeFunctionReference<"mutation">("admin/e2eFixtures:consumeProviderOutcome");

const payloadSchemas = {
  create_bucket: z.object({ name: z.string().trim().min(1).max(200) }),
  ingest_remote: z.object({
    documents: z.array(z.object({
      bucketId: z.number().int().positive(),
      sourceUrl: z.string().url(),
      fileName: z.string().min(1).optional(),
      fileType: z.enum(["txt", "docx", "pptx", "xlsx", "pdf", "png", "jpg", "csv", "tsv", "json"]).optional(),
      searchData: z.record(z.string(), z.unknown()).optional(),
    })).min(1).max(100),
  }),
  copy_documents: z.object({
    fromBucket: z.number().int().positive(),
    toBucket: z.number().int().positive(),
    documentIds: z.array(z.string().min(1)).min(1).max(100),
  }),
  delete_documents: z.object({ documentIds: z.array(z.string().min(1)).min(1).max(100) }),
  poll_process: z.object({ processId: z.string().min(1) }),
} as const;

type Adapter = Pick<GroundxAdapter, "createBucket" | "ingestRemote" | "copyDocuments" | "deleteDocuments" | "getProcess">;

function normalizedFileSize(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : undefined;
}

export async function executeGroundxJob(adapter: Adapter, job: Doc<"integrationJobs">) {
  const raw: unknown = JSON.parse(job.payload);
  if (job.processId !== undefined || job.type === "poll_process") {
    const processId = job.processId ?? payloadSchemas.poll_process.parse(raw).processId;
    return await adapter.getProcess({ processId });
  }
  switch (job.type) {
    case "create_bucket": {
      const result = await adapter.createBucket(payloadSchemas.create_bucket.parse(raw));
      return { processId: `bucket-${result.bucketId}`, status: "complete" as const };
    }
    case "ingest_remote":
      return await adapter.ingestRemote(payloadSchemas.ingest_remote.parse(raw));
    case "copy_documents":
      return await adapter.copyDocuments(payloadSchemas.copy_documents.parse(raw));
    case "delete_documents":
      return await adapter.deleteDocuments(payloadSchemas.delete_documents.parse(raw));
  }
}

export const runGroundxJob = internalAction({
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
    if (resolveE2EProviderIsolation() === "stub") {
      const outcome = await ctx.runMutation(consumeE2EProviderOutcomeRef, { jobId: args.jobId }) as "succeeded" | "failed";
      if (outcome === "failed") {
        await ctx.runMutation(failureRef, {
          jobId: args.jobId,
          leaseToken,
          kind: "provider",
        });
        return null;
      }
      await ctx.runMutation(resultRef, {
        jobId: args.jobId,
        leaseToken,
        processId: `e2e_stub_${job._id}`,
        status: "complete",
      });
      return null;
    }
    const apiKey = process.env.GROUNDX_API_KEY;
    if (!apiKey) {
      await ctx.runMutation(failureRef, {
        jobId: args.jobId,
        leaseToken,
        kind: "authentication",
      });
      return null;
    }
    let result: Awaited<ReturnType<typeof executeGroundxJob>>;
    const adapter = new GroundxAdapter({ apiKey });
    try {
      result = await executeGroundxJob(adapter, job);
    } catch (error) {
      const kind = error instanceof ProviderError ? error.kind : "invalid_response";
      await ctx.runMutation(failureRef, {
        jobId: args.jobId,
        leaseToken,
        kind,
      });
      return null;
    }
    let documentEvidence:
      | {
          documentId: string;
          status: "queued" | "processing" | "complete" | "error" | "cancelled";
          fileType?: "txt" | "docx" | "pptx" | "xlsx" | "pdf" | "png" | "jpg" | "csv" | "tsv" | "json";
          fileSize?: number;
        }
      | undefined;
    if (job.targetType === "documentVersion" && ["ingest_remote", "poll_process"].includes(job.type)) {
      try {
        const target = (await ctx.runQuery(evidenceTargetRef, {
          versionId: job.targetId,
        })) as { documentId: string } | null;
        if (target) {
          const document = await adapter.getDocument(target);
          if (document.documentId === target.documentId) {
            documentEvidence = {
              documentId: document.documentId,
              status: document.status ?? result.status,
              ...(document.fileType === undefined ? {} : { fileType: document.fileType }),
              ...(normalizedFileSize(document.fileSize) === undefined
                ? {}
                : { fileSize: normalizedFileSize(document.fileSize) }),
            };
          }
        }
      } catch {
        // Evidence is supplementary. A failed lookup must remain unavailable
        // rather than replacing the authoritative provider job outcome.
      }
    }
    await ctx.runMutation(resultRef, {
      jobId: args.jobId,
      leaseToken,
      processId: result.processId,
      status: result.status,
      ...(documentEvidence?.status === result.status ? { documentEvidence } : {}),
    });
    return null;
  },
});
