import { ConvexError, v, type Infer } from "convex/values";
import { internalQuery } from "../_generated/server";
import { isGeminiFileSearchStoreName, isGeminiUploadOperationForStore } from "../lib/geminiFileSearchNames";

export const indexDiagnosticJobValidator = v.object({
  id: v.id("integrationJobs"),
  status: v.union(v.literal("manual_review"), v.literal("waiting_provider"), v.literal("running")),
  correlationId: v.string(),
  providerPollingStartedAt: v.union(v.number(), v.null()),
  providerPollCount: v.number(),
  updatedAt: v.number(),
});

export const indexDiagnosticContextValidator = v.object({
  job: indexDiagnosticJobValidator,
  target: v.object({
    storeName: v.string(),
    operationName: v.string(),
    metadata: v.object({
      environment: v.string(), jurisdiction_id: v.string(), resource_id: v.string(),
      version_id: v.string(), version_number: v.string(), sha256: v.string(),
    }),
  }),
});

export type IndexDiagnosticContext = Infer<typeof indexDiagnosticContextValidator>;

function invalidTarget(): never {
  throw new ConvexError("GEMINI_DIAGNOSTIC_TARGET_INVALID");
}

/** Privileged diagnostic input only. No leases, signed URLs, or state transitions. */
export const getIndexDiagnosticTarget = internalQuery({
  args: { jobId: v.id("integrationJobs") },
  returns: indexDiagnosticContextValidator,
  handler: async (ctx, { jobId }): Promise<IndexDiagnosticContext> => {
    const job = await ctx.db.get(jobId);
    if (!job || job.type !== "gemini_index_document" || job.targetType !== "documentVersion"
      || (job.status !== "manual_review" && job.status !== "waiting_provider" && job.status !== "running")
      || job.recoveryKind !== "poll_operation" || !job.providerOperationName) invalidTarget();
    if (new TextEncoder().encode(job.payload).byteLength > 8_192) invalidTarget();
    let parsed: unknown;
    try { parsed = JSON.parse(job.payload); } catch { invalidTarget(); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalidTarget();
    const payload = parsed as Record<string, unknown>;
    if (!Object.keys(payload).every(key => ["operation", "storeName", "sha256", "previousVersionId", "reasonDigest"].includes(key))
      || !["publish", "replace_index", "rollback_index"].includes(String(payload.operation))
      || (payload.reasonDigest !== undefined && (typeof payload.reasonDigest !== "string" || !/^[a-f0-9]{64}$/.test(payload.reasonDigest)))) invalidTarget();
    const versionId = ctx.db.normalizeId("documentVersions", job.targetId);
    const version = versionId ? await ctx.db.get(versionId) : null;
    const resource = version ? await ctx.db.get(version.resourceId) : null;
    const jurisdiction = resource ? await ctx.db.get(resource.jurisdictionId) : null;
    const storeName = jurisdiction?.geminiFileSearchStoreName;
    if (!version || !resource || !jurisdiction || !storeName || !isGeminiFileSearchStoreName(storeName)
      || payload.storeName !== storeName || payload.sha256 !== version.sha256 || !/^[a-f0-9]{64}$/.test(version.sha256)
      || !Number.isSafeInteger(version.versionNumber) || version.versionNumber < 1
      || !isGeminiUploadOperationForStore(job.providerOperationName, storeName)
      || (job.organizationId !== undefined && job.organizationId !== jurisdiction.organizationId)) invalidTarget();
    if (payload.operation === "publish") {
      if (payload.previousVersionId !== undefined) invalidTarget();
    } else {
      const previousId = typeof payload.previousVersionId === "string"
        ? ctx.db.normalizeId("documentVersions", payload.previousVersionId) : null;
      const previous = previousId ? await ctx.db.get(previousId) : null;
      if (!previous || previous.resourceId !== resource._id || previous._id === version._id) invalidTarget();
    }
    const owners = await ctx.db.query("jurisdictions")
      .withIndex("by_gemini_store_name", q => q.eq("geminiFileSearchStoreName", storeName)).take(2);
    if (owners.length !== 1 || owners[0]._id !== jurisdiction._id) invalidTarget();
    const environment = process.env.ADMIN_ENVIRONMENT?.trim();
    if (!environment || environment.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(environment)) {
      throw new ConvexError("GEMINI_DIAGNOSTIC_ENVIRONMENT_INVALID");
    }
    return {
      job: { id: job._id, status: job.status, correlationId: job.correlationId,
        providerPollingStartedAt: job.providerPollingStartedAt ?? null,
        providerPollCount: job.providerPollCount ?? 0, updatedAt: job.updatedAt },
      target: { storeName, operationName: job.providerOperationName, metadata: {
        environment, jurisdiction_id: jurisdiction._id, resource_id: resource._id,
        version_id: version._id, version_number: String(version.versionNumber), sha256: version.sha256,
      } },
    };
  },
});
