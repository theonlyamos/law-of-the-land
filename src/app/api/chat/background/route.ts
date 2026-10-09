import { makeFunctionReference } from "convex/server";
import { after } from "next/server";
import { fetchAuthQuery, isAuthenticated } from "@/lib/auth-server";
import { createReviewedEmploymentBackgroundAdmission, isReviewedEmploymentBackgroundReadRequest, isReviewedEmploymentBackgroundExecutionEnabled } from "@/lib/source-verification/reviewed-employment-background-enabled";
import { runReviewedEmploymentJob } from "@/lib/source-verification/reviewed-employment-job-worker";
import { reviewedEmploymentNextEnvironment } from "@/lib/source-verification/reviewed-employment-next-environment";
import { parseReviewedEmploymentJobProjection, type ReviewedEmploymentJobProjection } from "../../../../../shared/reviewed-employment-jobs";

export const runtime = "nodejs";
export const maxDuration = 300;
const getForChat = makeFunctionReference<"query", { externalId: string; jobId?: string }, ReviewedEmploymentJobProjection | null>("reviewedEmploymentJobs:getForChat");
const headers = { "cache-control": "no-store, private" };

export async function GET(request: Request): Promise<Response> {
  const requestStartedAt = Date.now();
  const requestStartedMonotonic = performance.now();
  // The exact supported deployment is required even while new work is disabled.
  // Once installed, owner reads and cancellation survive admission rollback.
  if (!isReviewedEmploymentBackgroundReadRequest(request, reviewedEmploymentNextEnvironment())) {
    return Response.json({ enabled: false, job: null }, { headers });
  }
  const admission = createReviewedEmploymentBackgroundAdmission(requestStartedAt, requestStartedMonotonic);
  try {
    if (!(await admission.run(() => isAuthenticated()))) return Response.json({ error: "Sign in to view verification progress." }, { status: 401, headers });
    const params = new URL(request.url).searchParams;
    const chat = params.get("chat");
    const jobId = params.get("job");
    if ([...params.keys()].some(key => key !== "chat" && key !== "job") || params.getAll("chat").length !== 1
      || !chat || chat.length > 200 || chat !== chat.trim()
      || (params.has("job") && (params.getAll("job").length !== 1 || !jobId || jobId.length > 200 || jobId !== jobId.trim()))) {
      return Response.json({ error: "Choose a chat to view verification progress." }, { status: 400, headers });
    }
    const value: unknown = await admission.run(() => fetchAuthQuery(getForChat, { externalId: chat, ...(jobId ? { jobId } : {}) }));
    const job = value === null ? null : parseReviewedEmploymentJobProjection(value);
    if (value !== null && (!job || job.externalId !== chat || (jobId && job.jobId !== jobId))) throw new Error("CHAT_BACKGROUND_JOB_RESULT_INVALID");
    // A saved submit may outlive a lost RPC response. Recover only work that has
    // never been claimed; the atomic first claim makes concurrent reads safe.
    admission.assertWithinDeadline();
    if (job?.status === "queued" && isReviewedEmploymentBackgroundExecutionEnabled(reviewedEmploymentNextEnvironment())) after(() => runReviewedEmploymentJob(job.jobId));
    return Response.json({ enabled: true, job }, { headers });
  } catch {
    return Response.json({ error: "Verification progress could not be read. Please try again." }, { status: 500, headers });
  } finally {
    admission.dispose();
  }
}
