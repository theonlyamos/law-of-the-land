"use node";
import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internalAction } from "../_generated/server";
import { resolveE2EProviderIsolation } from "./e2eProviderIsolation";
import type { FailedDocumentRecoveryClaim, FailedDocumentRecoveryResult } from "./geminiFailedRecovery";
import { verifyFailedGeminiDocumentCoverage } from "./integrations/geminiFailedDocumentCoverage";
const claimRef = makeFunctionReference<"mutation">("admin/geminiFailedRecovery:claimFailedDocumentRecovery");
const completeRef = makeFunctionReference<"mutation">("admin/geminiFailedRecovery:completeFailedDocumentRecovery");
const abortRef = makeFunctionReference<"mutation">("admin/geminiFailedRecovery:abortFailedDocumentRecovery");
/** Explicit deployment-admin reconciliation; all provider operations are bounded GET requests. */
export const reconcileFailedDocument = internalAction({
  args: { jobId: v.id("integrationJobs"), reason: v.string(), idempotencyKey: v.string() },
  returns: v.object({ status: v.union(v.literal("succeeded"), v.literal("failed")), jobId: v.id("integrationJobs"), correlationId: v.string() }),
  handler: async (ctx, args): Promise<FailedDocumentRecoveryResult> => {
    if (resolveE2EProviderIsolation() !== "normal") throw new ConvexError("GEMINI_FAILED_DOCUMENT_RECOVERY_UNAVAILABLE_IN_E2E");
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey?.trim()) throw new ConvexError("GEMINI_FAILED_DOCUMENT_RECOVERY_NOT_CONFIGURED");
    const claim: FailedDocumentRecoveryClaim = await ctx.runMutation(claimRef, args);
    if (claim.kind === "completed") return claim.result;
    const attempt = { operationId: claim.operationId, leaseToken: claim.leaseToken, binding: claim.binding, jurisdictionId: claim.jurisdictionId };
    try {
      const proof = await verifyFailedGeminiDocumentCoverage(claim.coverage, apiKey);
      return await ctx.runMutation(completeRef, { ...attempt, ...proof });
    } catch {
      try { return await ctx.runMutation(abortRef, attempt); }
      catch { throw new ConvexError("GEMINI_FAILED_DOCUMENT_RECOVERY_FAILED"); }
    }
  },
});
