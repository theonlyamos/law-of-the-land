"use node";

import { makeFunctionReference } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import { action, internalAction } from "../_generated/server";
import { resolveE2EProviderIsolation } from "./e2eProviderIsolation";
import { adminIndexDiagnosticDetailValidator, indexDiagnosticJobValidator, type IndexDiagnosticContext } from "./geminiDiagnostics";
import { geminiDiagnosticResultValidator, inspectGeminiProvider } from "./integrations/geminiDiagnostic";

const targetRef = makeFunctionReference<"query">("admin/geminiDiagnostics:getIndexDiagnosticTarget");

/** Deployment-admin inspection only: provider reads, with no persistence or recovery. */
export const inspectIndexJob = internalAction({
  args: { jobId: v.id("integrationJobs") },
  returns: v.object({
    observedAt: v.number(),
    job: indexDiagnosticJobValidator,
    provider: geminiDiagnosticResultValidator,
  }),
  handler: async (ctx, { jobId }) => {
    if (resolveE2EProviderIsolation() !== "normal") {
      throw new ConvexError("GEMINI_DIAGNOSTIC_UNAVAILABLE_IN_E2E");
    }
    const context: IndexDiagnosticContext = await ctx.runQuery(targetRef, { jobId });
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey?.trim()) throw new ConvexError("GEMINI_DIAGNOSTIC_NOT_CONFIGURED");
    try {
      const provider = await inspectGeminiProvider(context.target, apiKey);
      return { observedAt: Date.now(), job: context.job, provider };
    } catch {
      // Never send SDK exception bodies, request URLs, or credentials to callers/logs.
      throw new ConvexError("GEMINI_DIAGNOSTIC_READ_FAILED");
    }
  },
});

const authorizeInspectionRef = makeFunctionReference<"query">("admin/geminiDiagnostics:authorizeIndexInspection");
const inspectIndexJobRef = makeFunctionReference<"action">("admin/geminiDiagnosticActions:inspectIndexJob");

const adminInspectionResultValidator = v.object({
  observedAt: v.number(), job: indexDiagnosticJobValidator,
  detail: adminIndexDiagnosticDetailValidator, provider: geminiDiagnosticResultValidator,
});

/** Explicit operator inspection. No job transitions, provider writes, or scheduled work. */
export const inspectIndexJobForAdmin = action({
  args: { jobId: v.id("integrationJobs") },
  returns: adminInspectionResultValidator,
  handler: async (ctx, { jobId }): Promise<Infer<typeof adminInspectionResultValidator>> => {
    const before = await ctx.runQuery(authorizeInspectionRef, { jobId });
    const result = await ctx.runAction(inspectIndexJobRef, { jobId });
    // A slow provider scan must not disclose results after access or target changes.
    const detail = await ctx.runQuery(authorizeInspectionRef, { jobId });
    if (JSON.stringify(before) !== JSON.stringify(detail)) throw new ConvexError("GEMINI_DIAGNOSTIC_TARGET_CHANGED");
    return { observedAt: result.observedAt, job: result.job, provider: result.provider, detail };
  },
});
