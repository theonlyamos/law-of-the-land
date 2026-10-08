// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_REVIEWED_EMPLOYMENT_POLICY, REVIEWED_EMPLOYMENT_POLICY,
  reviewedEmploymentNextPolicy } from "../../../shared/reviewed-employment-policy";
import { isReviewedEmploymentBackgroundExecutionEnabled, isReviewedEmploymentBackgroundReadRequest,
  isReviewedEmploymentBackgroundRequest } from "./reviewed-employment-background-enabled";
import { reviewedEmploymentNextEnvironment } from "./reviewed-employment-next-environment";

const CLOUD = "https://loyal-koala-720.eu-west-1.convex.cloud";
const SITE = "https://loyal-koala-720.eu-west-1.convex.site";
const runtime = {
  NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production",
  REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED: "1",
  REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED: "1",
};
const post = () => new Request("https://lawoftheland.vercel.app/api/chat", {
  method: "POST", headers: { origin: "https://lawoftheland.vercel.app" },
});
const read = () => new Request("https://lawoftheland.vercel.app/api/chat/background");

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", CLOUD);
  vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", SITE);
});
afterEach(() => vi.unstubAllEnvs());

describe("Next reviewed employment deployment selector capture", () => {
  it("resolves the exact build binding when public URLs are absent from native runtime", () => {
    const env = reviewedEmploymentNextEnvironment(runtime);
    expect(reviewedEmploymentNextPolicy(env)).toBe(PRODUCTION_REVIEWED_EMPLOYMENT_POLICY);
    expect(isReviewedEmploymentBackgroundRequest(post(), env)).toBe(true);
  });

  it.each(["NEXT_PUBLIC_CONVEX_URL", "NEXT_PUBLIC_CONVEX_SITE_URL"])(
    "rejects a native %s conflicting with the captured build binding", key => {
      const env = reviewedEmploymentNextEnvironment({ ...runtime,
        NEXT_PUBLIC_CONVEX_URL: CLOUD, NEXT_PUBLIC_CONVEX_SITE_URL: SITE, [key]: "https://other.convex.test" });
      expect(reviewedEmploymentNextPolicy(env)).toBeNull();
      expect(isReviewedEmploymentBackgroundRequest(post(), env)).toBe(false);
      expect(isReviewedEmploymentBackgroundExecutionEnabled(env)).toBe(false);
      expect(isReviewedEmploymentBackgroundReadRequest(read(), env)).toBe(false);
    },
  );

  it.each(["NEXT_PUBLIC_CONVEX_URL", "NEXT_PUBLIC_CONVEX_SITE_URL"])(
    "fails closed when %s was not configured at build time", key => {
      vi.stubEnv(key, undefined);
      const env = reviewedEmploymentNextEnvironment({ ...runtime,
        NEXT_PUBLIC_CONVEX_URL: CLOUD, NEXT_PUBLIC_CONVEX_SITE_URL: SITE });
      expect(reviewedEmploymentNextPolicy(env)).toBeNull();
      expect(isReviewedEmploymentBackgroundRequest(post(), env)).toBe(false);
    },
  );

  it("reads current admission and execution flags while preserving owner access during rollback", () => {
    const native = { ...runtime };
    expect(isReviewedEmploymentBackgroundRequest(post(), reviewedEmploymentNextEnvironment(native))).toBe(true);
    native.REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED = "0";
    let env = reviewedEmploymentNextEnvironment(native);
    expect(isReviewedEmploymentBackgroundRequest(post(), env)).toBe(false);
    expect(isReviewedEmploymentBackgroundExecutionEnabled(env)).toBe(true);
    expect(isReviewedEmploymentBackgroundReadRequest(read(), env)).toBe(true);
    native.REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED = "0";
    env = reviewedEmploymentNextEnvironment(native);
    expect(isReviewedEmploymentBackgroundExecutionEnabled(env)).toBe(false);
    expect(isReviewedEmploymentBackgroundReadRequest(read(), env)).toBe(true);
    expect(isReviewedEmploymentBackgroundReadRequest(new Request(
      "https://lawoftheland.vercel.app/api/chat/background/cancel", {
        method: "POST", headers: { origin: "https://lawoftheland.vercel.app" },
      }), env)).toBe(true);
  });

  it.each(["NODE_ENV", "VERCEL", "VERCEL_ENV", "CONVEX_DEPLOYMENT"])(
    "preserves the fail-closed native runtime identity check for %s", key => {
      const env = reviewedEmploymentNextEnvironment({ ...runtime, [key]: "unsupported" });
      expect(reviewedEmploymentNextPolicy(env)).toBeNull();
      expect(isReviewedEmploymentBackgroundRequest(post(), env)).toBe(false);
      expect(isReviewedEmploymentBackgroundReadRequest(read(), env)).toBe(false);
    },
  );

  it("preserves the exact local DEV binding and approved-call controls", () => {
    const localCloud = "https://adventurous-hummingbird-244.eu-west-1.convex.cloud";
    const localSite = "https://adventurous-hummingbird-244.eu-west-1.convex.site";
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", localCloud);
    vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", localSite);
    const native = { NODE_ENV: "development", CONVEX_DEPLOYMENT: "dev:adventurous-hummingbird-244",
      NEXT_PUBLIC_CONVEX_URL: localCloud, NEXT_PUBLIC_CONVEX_SITE_URL: localSite,
      LOCAL_REVIEWED_EMPLOYMENT_ENABLED: "1", LOCAL_REVIEWED_EMPLOYMENT_BACKGROUND_ENABLED: "1",
      LOCAL_REVIEWED_EMPLOYMENT_SPLIT_ENABLED: "1", LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED: "1" };
    expect(reviewedEmploymentNextPolicy(reviewedEmploymentNextEnvironment(native))).toBe(REVIEWED_EMPLOYMENT_POLICY);
    expect(isReviewedEmploymentBackgroundExecutionEnabled(reviewedEmploymentNextEnvironment(native))).toBe(true);
    native.LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED = "0";
    expect(isReviewedEmploymentBackgroundExecutionEnabled(reviewedEmploymentNextEnvironment(native))).toBe(false);
    expect(isReviewedEmploymentBackgroundReadRequest(new Request(
      "http://localhost:3000/api/chat/background"), reviewedEmploymentNextEnvironment(native))).toBe(true);
  });

  it("excludes native credentials and unrelated environment fields", () => {
    const env = reviewedEmploymentNextEnvironment({ ...runtime, GOOGLE_AI_API_KEY: "synthetic-test-only",
      TELEMETRY_INGEST_SECRET: "synthetic-test-only", EXTRA_FLAG: "synthetic-test-only" });
    expect(env).not.toHaveProperty("GOOGLE_AI_API_KEY");
    expect(env).not.toHaveProperty("TELEMETRY_INGEST_SECRET");
    expect(env).not.toHaveProperty("EXTRA_FLAG");
  });
});
