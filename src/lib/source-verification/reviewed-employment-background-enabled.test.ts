// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isLocalReviewedEmploymentBackgroundRequest, isReviewedEmploymentBackgroundRequest,
  isReviewedEmploymentBackgroundReadRequest, isReviewedEmploymentBackgroundExecutionEnabled } from "./reviewed-employment-background-enabled";

const local = {
  NODE_ENV: "development", LOCAL_REVIEWED_EMPLOYMENT_ENABLED: "1",
  LOCAL_REVIEWED_EMPLOYMENT_BACKGROUND_ENABLED: "1", LOCAL_REVIEWED_EMPLOYMENT_SPLIT_ENABLED: "1",
  LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED: "1", CONVEX_DEPLOYMENT: "dev:adventurous-hummingbird-244",
  NEXT_PUBLIC_CONVEX_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.cloud",
  NEXT_PUBLIC_CONVEX_SITE_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.site",
};
const production = {
  NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production",
  NEXT_PUBLIC_CONVEX_URL: "https://loyal-koala-720.eu-west-1.convex.cloud",
  NEXT_PUBLIC_CONVEX_SITE_URL: "https://loyal-koala-720.eu-west-1.convex.site",
  REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED: "1",
  REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED: "1",
};
const post = (url: string, origin = new URL(url).origin) => new Request(url, { method: "POST", headers: { origin } });

describe("reviewed employment background request boundaries", () => {
  it("admits only the exact enabled production origin", () => {
    expect(isLocalReviewedEmploymentBackgroundRequest(post("https://lawoftheland.vercel.app/api/chat"), production)).toBe(true);
    expect(isLocalReviewedEmploymentBackgroundRequest(post("https://preview.vercel.app/api/chat", "https://lawoftheland.vercel.app"), production)).toBe(false);
    expect(isLocalReviewedEmploymentBackgroundRequest(post("https://lawoftheland.vercel.app/api/chat", "https://foreign.example"), production)).toBe(false);
  });
  it.each([undefined, "0", "true"])("keeps production admission default-off for non-enabled flags %s", flag => {
    for (const key of ["REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED", "REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED"]) {
      expect(isReviewedEmploymentBackgroundRequest(post("https://lawoftheland.vercel.app/api/chat"), { ...production, [key]: flag })).toBe(false);
    }
  });
  it.each(["NODE_ENV", "VERCEL", "VERCEL_ENV", "CONVEX_DEPLOYMENT", "NEXT_PUBLIC_CONVEX_URL", "NEXT_PUBLIC_CONVEX_SITE_URL"])("fails closed for an unsupported production runtime %s", key => {
    const env = { ...production, [key]: "unexpected" };
    expect(isReviewedEmploymentBackgroundRequest(post("https://lawoftheland.vercel.app/api/chat"), env)).toBe(false);
    expect(isReviewedEmploymentBackgroundReadRequest(new Request("https://lawoftheland.vercel.app/api/chat/background"), env)).toBe(false);
    expect(isReviewedEmploymentBackgroundExecutionEnabled(env)).toBe(false);
  });
  it("separates production admission rollback from execution draining and owner reads", () => {
    const env = { ...production, REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED: "0" };
    expect(isReviewedEmploymentBackgroundRequest(post("https://lawoftheland.vercel.app/api/chat"), env)).toBe(false);
    expect(isReviewedEmploymentBackgroundExecutionEnabled(env)).toBe(true);
    expect(isReviewedEmploymentBackgroundReadRequest(new Request("https://lawoftheland.vercel.app/api/chat/background"), env)).toBe(true);
    expect(isReviewedEmploymentBackgroundReadRequest(post("https://lawoftheland.vercel.app/api/chat/background/cancel"), env)).toBe(true);
  });
  it("retains local and production owner lifecycle access during execution rollback", () => {
    const prodOff = { ...production, REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED: "0", REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED: "0" };
    const localOff = { ...local, LOCAL_REVIEWED_EMPLOYMENT_BACKGROUND_ENABLED: "0", LOCAL_REVIEWED_EMPLOYMENT_SPLIT_ENABLED: "0", LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED: "0" };
    for (const [origin, env] of [["https://lawoftheland.vercel.app", prodOff], ["http://localhost:3000", localOff]] as const) {
      expect(isReviewedEmploymentBackgroundExecutionEnabled(env)).toBe(false);
      expect(isReviewedEmploymentBackgroundRequest(post(`${origin}/api/chat`), env)).toBe(false);
      expect(isReviewedEmploymentBackgroundReadRequest(new Request(`${origin}/api/chat/background`), env)).toBe(true);
      expect(isReviewedEmploymentBackgroundReadRequest(post(`${origin}/api/chat/background/cancel`), env)).toBe(true);
    }
  });
  it("rejects cross-origin reads and cancellation even during production rollback", () => {
    const env = { ...production, REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED: "0" };
    for (const request of [
      new Request("https://lawoftheland.vercel.app/api/chat/background", { headers: { origin: "https://foreign.example" } }),
      new Request("https://lawoftheland.vercel.app/api/chat/background", { headers: { "sec-fetch-site": "cross-site" } }),
      new Request("https://preview.vercel.app/api/chat/background", { headers: { origin: "https://lawoftheland.vercel.app" } }),
      post("http://lawoftheland.vercel.app/api/chat/background/cancel"),
      post("https://lawoftheland.vercel.app:444/api/chat/background/cancel"),
      new Request("https://lawoftheland.vercel.app/api/chat/background/cancel", { method: "POST" }),
      new Request("https://lawoftheland.vercel.app/api/chat/background", { method: "PUT", headers: { origin: "https://lawoftheland.vercel.app" } }),
    ]) expect(isReviewedEmploymentBackgroundReadRequest(request, env)).toBe(false);
  });
});
