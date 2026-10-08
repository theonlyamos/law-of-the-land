import { makeFunctionReference } from "convex/server";
import { fetchAuthMutation, isAuthenticated } from "@/lib/auth-server";
import { readAttachmentBody } from "@/lib/chat-attachment-server";
import { isReviewedEmploymentBackgroundReadRequest } from "@/lib/source-verification/reviewed-employment-background-enabled";
import { reviewedEmploymentNextEnvironment } from "@/lib/source-verification/reviewed-employment-next-environment";
import { parseReviewedEmploymentJobProjection, type ReviewedEmploymentJobProjection } from "../../../../../../shared/reviewed-employment-jobs";

export const runtime = "nodejs";
const cancelJob = makeFunctionReference<"mutation", { jobId: string }, ReviewedEmploymentJobProjection | null>("reviewedEmploymentJobs:cancel");
const headers = { "cache-control": "no-store, private" };

export async function POST(request: Request): Promise<Response> {
  if (!isReviewedEmploymentBackgroundReadRequest(request, reviewedEmploymentNextEnvironment())) {
    return Response.json({ error: "This verification option is not available here." }, { status: 403, headers });
  }
  try {
    if (!(await isAuthenticated())) return Response.json({ error: "Sign in to cancel verification." }, { status: 401, headers });
    let jobId: string;
    try {
      const bytes = await readAttachmentBody(request, 4096, AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]));
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).join(",") !== "jobId" || !("jobId" in value)
        || typeof value.jobId !== "string" || !value.jobId || value.jobId.length > 200 || value.jobId !== value.jobId.trim()) {
        throw new Error("CHAT_BACKGROUND_CANCEL_INVALID");
      }
      jobId = value.jobId;
    } catch {
      return Response.json({ error: "Choose a saved verification to cancel." }, { status: 400, headers });
    }
    const value: unknown = await fetchAuthMutation(cancelJob, { jobId });
    const job = value === null ? null : parseReviewedEmploymentJobProjection(value);
    if (value !== null && (!job || job.jobId !== jobId)) throw new Error("CHAT_BACKGROUND_JOB_RESULT_INVALID");
    return Response.json({ job }, { headers });
  } catch {
    return Response.json({ error: "Verification could not be cancelled. Please try again." }, { status: 500, headers });
  }
}
