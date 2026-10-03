"use node";

import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internalAction } from "../_generated/server";
import { resolveE2EProviderIsolation } from "./e2eProviderIsolation";
import type { ActiveDocumentRecoveryClaim, ActiveDocumentRecoveryResult } from "./geminiRecovery";
import { verifyActiveGeminiDocument } from "./integrations/geminiActiveDocument";

const claimRef = makeFunctionReference<"mutation">("admin/geminiRecovery:claimActiveDocumentRecovery");
const completeRef = makeFunctionReference<"mutation">("admin/geminiRecovery:completeActiveDocumentRecovery");
const abortRef = makeFunctionReference<"mutation">("admin/geminiRecovery:abortActiveDocumentRecovery");

/** Deployment-admin recovery using fresh provider reads and guarded atomic completion. */
export const reconcileActiveDocument = internalAction({
  args: { jobId: v.id("integrationJobs"), reason: v.string(), idempotencyKey: v.string() },
  returns: v.object({
    status: v.union(v.literal("succeeded"), v.literal("failed")),
    jobId: v.id("integrationJobs"), correlationId: v.string(),
  }),
  handler: async (ctx, args): Promise<ActiveDocumentRecoveryResult> => {
    if (resolveE2EProviderIsolation() !== "normal") {
      throw new ConvexError("GEMINI_ACTIVE_DOCUMENT_RECOVERY_UNAVAILABLE_IN_E2E");
    }
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey?.trim()) throw new ConvexError("GEMINI_ACTIVE_DOCUMENT_RECOVERY_NOT_CONFIGURED");

    const claim: ActiveDocumentRecoveryClaim = await ctx.runMutation(claimRef, args);
    if (claim.kind === "completed") return claim.result;

    const attempt = {
      operationId: claim.operationId, leaseToken: claim.leaseToken,
      binding: claim.binding, jurisdictionId: claim.jurisdictionId,
    };
    try {
      const proof = await verifyActiveGeminiDocument(claim.target, apiKey);
      return await ctx.runMutation(completeRef, { ...attempt, ...proof });
    } catch {
      // A failed read or stale completion must only release this bound attempt.
      // Provider errors and private proof/lease fields never enter the result.
      try {
        return await ctx.runMutation(abortRef, attempt);
      } catch {
        throw new ConvexError("GEMINI_ACTIVE_DOCUMENT_RECOVERY_FAILED");
      }
    }
  },
});
