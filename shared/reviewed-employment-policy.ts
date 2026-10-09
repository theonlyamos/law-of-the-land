/** The atomic backend boundary must independently pin the reviewed source.
 * Keep these deployment selectors aligned with local-pilot-cases.ts. They are
 * not authorization grants and importing this module loads no source passages.
 */
export const REVIEWED_EMPLOYMENT_POLICY = Object.freeze({
  jurisdictionId: "md744z756x2etfcscnx9ayys8n8dp2mc",
  resourceId: "mh72janpeqm7zpa406pm1hxwvx8dpvr2",
  versionId: "kh70hvbgwbfnrsjhsxhcc9m56x8dp9rw",
  expectedSha256: "125e8ce4d70beb6fbe6adc5f9cbaec27dc435c484a62b3eee38bf80cff466f5a",
  expectedByteSize: 1913139,
});

export type ReviewedEmploymentPolicy = Readonly<{
  jurisdictionId: string; resourceId: string; versionId: string;
  expectedSha256: string; expectedByteSize: number;
}>;
export const PRODUCTION_REVIEWED_EMPLOYMENT_POLICY: ReviewedEmploymentPolicy = Object.freeze({
  jurisdictionId: "md791bzzqyzd0qdtman23jar7d8ds244",
  resourceId: "mh7f6wbf5e8nt6sb47wwddwn9s8dsjqa",
  versionId: "kd7c80kgs1zzdcw1qhydrdwyas8dsysw",
  expectedSha256: REVIEWED_EMPLOYMENT_POLICY.expectedSha256,
  expectedByteSize: REVIEWED_EMPLOYMENT_POLICY.expectedByteSize,
});
export type ReviewedEmploymentPolicyId = "act651-s55-dev-v1" | "act651-s55-prod-v1";
/** Trusted adapters accept only these two immutable catalog bindings. Capture
 * the canonical constant rather than retaining a caller-owned mutable object. */
export function captureReviewedEmploymentPolicy(policy: ReviewedEmploymentPolicy): ReviewedEmploymentPolicy | null {
  if (!policy || typeof policy !== "object" || Object.keys(policy).length !== 5) return null;
  for (const allowed of [REVIEWED_EMPLOYMENT_POLICY, PRODUCTION_REVIEWED_EMPLOYMENT_POLICY]) {
    if (Object.entries(allowed).every(([key, value]) => policy[key as keyof ReviewedEmploymentPolicy] === value)) return allowed;
  }
  return null;
}
type Environment = Readonly<Record<string, string | undefined>>;
const DEV_CLOUD = "https://adventurous-hummingbird-244.eu-west-1.convex.cloud";
const DEV_SITE = "https://adventurous-hummingbird-244.eu-west-1.convex.site";
const PROD_CLOUD = "https://loyal-koala-720.eu-west-1.convex.cloud";
const PROD_SITE = "https://loyal-koala-720.eu-west-1.convex.site";

/** Deployment identity selects a pinned edition; it never grants user access.
 * Unknown and partially configured runtimes fail closed. Offline tests have no
 * hosted deployment and deliberately retain the legacy DEV fixture policy. */
export function reviewedEmploymentBackendPolicy(env: Environment): ReviewedEmploymentPolicy | null {
  if (env.CONVEX_CLOUD_URL === PROD_CLOUD && env.CONVEX_SITE_URL === PROD_SITE) return PRODUCTION_REVIEWED_EMPLOYMENT_POLICY;
  if (env.CONVEX_CLOUD_URL === DEV_CLOUD && env.CONVEX_SITE_URL === DEV_SITE) return REVIEWED_EMPLOYMENT_POLICY;
  if (env.NODE_ENV === "test" && env.CONVEX_CLOUD_URL === undefined && env.CONVEX_SITE_URL === undefined) return REVIEWED_EMPLOYMENT_POLICY;
  return null;
}
export function reviewedEmploymentBackendPolicyId(env: Environment): ReviewedEmploymentPolicyId | null {
  const policy = reviewedEmploymentBackendPolicy(env);
  return policy === PRODUCTION_REVIEWED_EMPLOYMENT_POLICY ? "act651-s55-prod-v1"
    : policy === REVIEWED_EMPLOYMENT_POLICY ? "act651-s55-dev-v1" : null;
}
export function reviewedEmploymentBackendJobPolicyMatches(env: Environment, policyId: string | undefined): boolean {
  const expected = reviewedEmploymentBackendPolicyId(env);
  return expected !== null && (policyId === expected || (policyId === undefined && expected === "act651-s55-dev-v1"));
}
export function reviewedEmploymentBackendExecutionAllowed(env: Environment): boolean {
  const policyId = reviewedEmploymentBackendPolicyId(env);
  return policyId === "act651-s55-dev-v1"
    || (policyId === "act651-s55-prod-v1" && env.REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED === "1");
}
export function reviewedEmploymentBackendAdmissionAllowed(env: Environment): boolean {
  const policyId = reviewedEmploymentBackendPolicyId(env);
  return policyId === "act651-s55-dev-v1" || (policyId === "act651-s55-prod-v1"
    && env.REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED === "1" && reviewedEmploymentBackendExecutionAllowed(env));
}

/** Read/cancel and saved citation access use the deployment binding independently
 * of the flags which admit new paid work or allow existing workers to execute. */
export function reviewedEmploymentNextPolicy(env: Environment): ReviewedEmploymentPolicy | null {
  if (env.NODE_ENV === "development" && env.LOCAL_REVIEWED_EMPLOYMENT_ENABLED === "1" && env.VERCEL === undefined
    && env.CONVEX_DEPLOYMENT === "dev:adventurous-hummingbird-244"
    && env.NEXT_PUBLIC_CONVEX_URL === DEV_CLOUD && env.NEXT_PUBLIC_CONVEX_SITE_URL === DEV_SITE) return REVIEWED_EMPLOYMENT_POLICY;
  if (env.NODE_ENV === "production" && env.VERCEL === "1" && env.VERCEL_ENV === "production"
    && (env.CONVEX_DEPLOYMENT === undefined || env.CONVEX_DEPLOYMENT === "prod:loyal-koala-720")
    && env.NEXT_PUBLIC_CONVEX_URL === PROD_CLOUD && env.NEXT_PUBLIC_CONVEX_SITE_URL === PROD_SITE) return PRODUCTION_REVIEWED_EMPLOYMENT_POLICY;
  return null;
}
export function productionReviewedEmploymentEnabled(env: Environment): boolean {
  return reviewedEmploymentNextPolicy(env) === PRODUCTION_REVIEWED_EMPLOYMENT_POLICY
    && env.REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED === "1"
    && env.REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED === "1";
}
