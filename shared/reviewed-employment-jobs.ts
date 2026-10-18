/** Shared closed contract for persisted local reviewed verification. It contains
 * no provider credentials, browser tokens, source text or private candidates. */
import { PUBLICATION_FILTER_PROTOCOL } from "./gemini-publication-filter";
export const REVIEWED_EMPLOYMENT_JOB_STATUSES = ["queued", "running", "succeeded", "blocked", "cancelled", "expired"] as const;
export const REVIEWED_EMPLOYMENT_JOB_PROGRESS = ["queued", "draft", "inventory", "consent", "overtime", "commit", "complete"] as const;
export const REVIEWED_EMPLOYMENT_JOB_ERRORS = ["invalid_request", "authority_unavailable", "draft_blocked", "verification_blocked", "commit_failed", "deadline_exceeded", "cancelled", "internal"] as const;
export const REVIEWED_EMPLOYMENT_JOB_STAGES = ["draft", "inventory", "consent", "overtime"] as const;
export type ReviewedEmploymentJobStatus = typeof REVIEWED_EMPLOYMENT_JOB_STATUSES[number];
export type ReviewedEmploymentJobProgress = typeof REVIEWED_EMPLOYMENT_JOB_PROGRESS[number];
export type ReviewedEmploymentJobError = typeof REVIEWED_EMPLOYMENT_JOB_ERRORS[number];
export type ReviewedEmploymentJobStage = typeof REVIEWED_EMPLOYMENT_JOB_STAGES[number];
export type ReviewedEmploymentJobProjection = Readonly<{
  jobId: string; externalId: string; userClientId: string; assistantClientId: string; question: string;
  status: ReviewedEmploymentJobStatus; progress: ReviewedEmploymentJobProgress; createdAt: number;
  verificationDeadlineAt: number; terminalDeadlineAt: number; errorReason: ReviewedEmploymentJobError | null;
}>;
export type ReviewedEmploymentJobOperation = "claim" | "state" | "authority" | "reserve" | "passed" | "fail" | "commit";
export type ReviewedEmploymentJobWorkerInput = Readonly<{
  publicationFilterProtocol?: typeof PUBLICATION_FILTER_PROTOCOL;
  jobId: string; workerId: string; operation: ReviewedEmploymentJobOperation; body: string; issuedAt: number;
}>;
export type ReviewedEmploymentJobSubmitInput = Readonly<{
  publicationFilterProtocol?: typeof PUBLICATION_FILTER_PROTOCOL;
  submissionId: string; externalId: string; jurisdictionId: string; userClientId: string; assistantClientId: string;
  submission: string; issuedAt: number;
}>;
export type ReviewedEmploymentJobClaim = Readonly<{
  jobId: string; submission: string; createdAt: number; verificationDeadlineAt: number; terminalDeadlineAt: number;
  externalId: string; jurisdictionId: string; userClientId: string; assistantClientId: string;
  policyId?: "act651-s55-dev-v1" | "act651-s55-prod-v1";
}>;
export type ReviewedEmploymentJobReservation = Readonly<{
  stage: ReviewedEmploymentJobStage; requestSha256: string; candidateSha256: string | null; sourceBinding: string;
}>;
export const REVIEWED_EMPLOYMENT_VERIFICATION_WINDOW_MS = 240_000;
export const REVIEWED_EMPLOYMENT_TERMINAL_WINDOW_MS = 270_000;
export const REVIEWED_EMPLOYMENT_JOB_PROOF_WINDOW_MS = 60_000;
export async function reviewedEmploymentJobProofParts(input: ReviewedEmploymentJobWorkerInput): Promise<readonly (string | number)[]> {
  return ["reviewed-employment-background-worker-v1", input.jobId, input.workerId, input.operation, input.body, input.issuedAt,
    ...(input.publicationFilterProtocol === undefined ? [] : ["publication-filter-protocol", input.publicationFilterProtocol])];
}
export async function reviewedEmploymentJobSubmitProofParts(input: ReviewedEmploymentJobSubmitInput): Promise<readonly (string | number)[]> {
  return ["reviewed-employment-background-submit-v1", input.submissionId, input.externalId, input.jurisdictionId,
    input.userClientId, input.assistantClientId, input.submission, input.issuedAt,
    ...(input.publicationFilterProtocol === undefined ? [] : ["publication-filter-protocol", input.publicationFilterProtocol])];
}
/** Strict transport projection shared by the route and UI. Extra keys close the
 * response so raw submission, candidate or worker authority can never leak. */
export function parseReviewedEmploymentJobProjection(value: unknown): ReviewedEmploymentJobProjection | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = ["jobId", "externalId", "userClientId", "assistantClientId", "question", "status", "progress", "createdAt",
    "verificationDeadlineAt", "terminalDeadlineAt", "errorReason"].sort();
  const actual = Object.keys(row).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) return null;
  const bounded = (item: unknown, maximum: number): item is string => typeof item === "string" && item.length > 0
    && item.length <= maximum && item === item.trim();
  const timestamp = (item: unknown): item is number => typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
  if (![row.jobId, row.externalId, row.userClientId, row.assistantClientId].every(item => bounded(item, 200))
    || typeof row.question !== "string" || !row.question.trim() || row.question.length > 4000
    || !REVIEWED_EMPLOYMENT_JOB_STATUSES.includes(row.status as ReviewedEmploymentJobStatus)
    || !REVIEWED_EMPLOYMENT_JOB_PROGRESS.includes(row.progress as ReviewedEmploymentJobProgress)
    || (row.errorReason !== null && !REVIEWED_EMPLOYMENT_JOB_ERRORS.includes(row.errorReason as ReviewedEmploymentJobError))
    || !timestamp(row.createdAt) || !timestamp(row.verificationDeadlineAt) || !timestamp(row.terminalDeadlineAt)
    || row.verificationDeadlineAt !== row.createdAt + REVIEWED_EMPLOYMENT_VERIFICATION_WINDOW_MS
    || row.terminalDeadlineAt !== row.createdAt + REVIEWED_EMPLOYMENT_TERMINAL_WINDOW_MS) return null;
  return row as unknown as ReviewedEmploymentJobProjection;
}
/** One canonical byte representation for a complete native authority snapshot.
 * Object key order is irrelevant; ordered store arrays remain part of the bind. */
export function reviewedEmploymentSourceBundleCanonicalJson(bundle: Readonly<{ source: unknown; manifest: unknown }>): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(item => canonical(item === undefined ? null : item)).join(",")}]`;
    if (value !== null && typeof value === "object") {
      const row = value as Record<string, unknown>;
      return `{${Object.keys(row).filter(key => row[key] !== undefined).sort()
        .map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("REVIEWED_EMPLOYMENT_SOURCE_BUNDLE_INVALID");
    return encoded;
  };
  return canonical(bundle);
}
