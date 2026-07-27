"use node";

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { z } from "zod";
import type { Doc } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import { GroundxAdapter, ProviderError } from "./integrations/groundx";

const getJobRef = makeFunctionReference<"query">("admin/jobs:getJobForRun");
const claimJobRef = makeFunctionReference<"mutation">("admin/jobs:claimJob");
const resultRef = makeFunctionReference<"mutation">("admin/jobs:applyProviderResult");
const failureRef = makeFunctionReference<"mutation">("admin/jobs:recordProviderFailure");

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

export async function executeGroundxJob(adapter: Adapter, job: Doc<"integrationJobs">) {
  const raw: unknown = JSON.parse(job.payload);
  if (job.status === "waiting_callback" || job.type === "poll_process") {
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
  args: { jobId: v.id("integrationJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const before = (await ctx.runQuery(getJobRef, { jobId: args.jobId })) as Doc<"integrationJobs"> | null;
    if (!before) return null;
    if (!(await ctx.runMutation(claimJobRef, { jobId: args.jobId }))) return null;
    const apiKey = process.env.GROUNDX_API_KEY;
    if (!apiKey) {
      await ctx.runMutation(failureRef, { jobId: args.jobId, kind: "authentication" });
      return null;
    }
    try {
      const result = await executeGroundxJob(new GroundxAdapter({ apiKey }), before);
      await ctx.runMutation(resultRef, {
        jobId: args.jobId,
        processId: result.processId,
        status: result.status,
      });
    } catch (error) {
      const kind = error instanceof ProviderError ? error.kind : "invalid_response";
      await ctx.runMutation(failureRef, {
        jobId: args.jobId,
        kind,
        retryable: error instanceof ProviderError ? error.retryable : false,
      });
    }
    return null;
  },
});
