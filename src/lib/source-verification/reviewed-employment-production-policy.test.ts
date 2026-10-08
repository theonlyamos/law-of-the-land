import { describe, expect, it } from "vitest";
import { PRODUCTION_REVIEWED_EMPLOYMENT_POLICY, REVIEWED_EMPLOYMENT_POLICY,
  reviewedEmploymentBackendAdmissionAllowed, reviewedEmploymentBackendExecutionAllowed,
  reviewedEmploymentBackendJobPolicyMatches, reviewedEmploymentBackendPolicy,
  reviewedEmploymentBackendPolicyId, reviewedEmploymentNextPolicy,
  productionReviewedEmploymentEnabled } from "../../../shared/reviewed-employment-policy";

const backend = { CONVEX_CLOUD_URL: "https://loyal-koala-720.eu-west-1.convex.cloud",
  CONVEX_SITE_URL: "https://loyal-koala-720.eu-west-1.convex.site" };
const next = { NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production",
  NEXT_PUBLIC_CONVEX_URL: backend.CONVEX_CLOUD_URL, NEXT_PUBLIC_CONVEX_SITE_URL: backend.CONVEX_SITE_URL };
const enabled = { REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED: "1", REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED: "1" };

describe("limited production edition and independent rollback controls", () => {
  it("pins the eligible production edition separately from DEV without changing reviewed bytes", () => {
    const policy = reviewedEmploymentBackendPolicy(backend);
    expect(policy).toEqual(PRODUCTION_REVIEWED_EMPLOYMENT_POLICY);
    expect(policy?.jurisdictionId).toBe("md791bzzqyzd0qdtman23jar7d8ds244");
    expect(policy?.resourceId).toBe("mh7f6wbf5e8nt6sb47wwddwn9s8dsjqa");
    expect(policy?.versionId).toBe("kd7c80kgs1zzdcw1qhydrdwyas8dsysw");
    expect(policy?.expectedSha256).toBe(REVIEWED_EMPLOYMENT_POLICY.expectedSha256);
    expect(policy?.expectedByteSize).toBe(1913139);
    expect(reviewedEmploymentBackendPolicyId(backend)).toBe("act651-s55-prod-v1");
  });
  it("is default off and permits admission only when execution also is enabled", () => {
    expect(reviewedEmploymentBackendAdmissionAllowed(backend)).toBe(false);
    expect(productionReviewedEmploymentEnabled(next)).toBe(false);
    expect(reviewedEmploymentBackendAdmissionAllowed({ ...backend, ...enabled })).toBe(true);
    expect(productionReviewedEmploymentEnabled({ ...next, ...enabled })).toBe(true);
    expect(reviewedEmploymentBackendAdmissionAllowed({ ...backend, ...enabled, REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED: "0" })).toBe(false);
  });
  it("can drain admitted work after admission rollback and retains edition resolution when execution stops", () => {
    const stoppedAdmission = { ...backend, ...enabled, REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED: "0" };
    expect(reviewedEmploymentBackendAdmissionAllowed(stoppedAdmission)).toBe(false);
    expect(reviewedEmploymentBackendExecutionAllowed(stoppedAdmission)).toBe(true);
    const stoppedExecution = { ...stoppedAdmission, REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED: "0" };
    expect(reviewedEmploymentBackendExecutionAllowed(stoppedExecution)).toBe(false);
    expect(reviewedEmploymentBackendPolicy(stoppedExecution)).toEqual(PRODUCTION_REVIEWED_EMPLOYMENT_POLICY);
    expect(reviewedEmploymentNextPolicy(next)).toEqual(PRODUCTION_REVIEWED_EMPLOYMENT_POLICY);
  });
  it("rejects previews, mismatched deployment selectors and unknown backend runtimes", () => {
    expect(reviewedEmploymentNextPolicy({ ...next, VERCEL_ENV: "preview" })).toBeNull();
    expect(reviewedEmploymentNextPolicy({ ...next, CONVEX_DEPLOYMENT: "dev:adventurous-hummingbird-244" })).toBeNull();
    expect(reviewedEmploymentNextPolicy({ ...next, NEXT_PUBLIC_CONVEX_SITE_URL: "https://other.convex.site" })).toBeNull();
    expect(reviewedEmploymentBackendPolicy({ ...backend, CONVEX_SITE_URL: "https://other.convex.site" })).toBeNull();
    expect(reviewedEmploymentBackendPolicy({})).toBeNull();
    expect(reviewedEmploymentBackendAdmissionAllowed({ ...enabled })).toBe(false);
  });
  it("binds production jobs to an immutable policy ID and accepts legacy missing IDs only in DEV", () => {
    expect(reviewedEmploymentBackendJobPolicyMatches(backend, "act651-s55-prod-v1")).toBe(true);
    expect(reviewedEmploymentBackendJobPolicyMatches(backend, "act651-s55-dev-v1")).toBe(false);
    expect(reviewedEmploymentBackendJobPolicyMatches(backend, undefined)).toBe(false);
    const dev = { CONVEX_CLOUD_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.cloud",
      CONVEX_SITE_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.site" };
    expect(reviewedEmploymentBackendJobPolicyMatches(dev, undefined)).toBe(true);
    expect(reviewedEmploymentBackendJobPolicyMatches(dev, "act651-s55-dev-v1")).toBe(true);
    expect(reviewedEmploymentBackendJobPolicyMatches(dev, "act651-s55-prod-v1")).toBe(false);
  });
});
