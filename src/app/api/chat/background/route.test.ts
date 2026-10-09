// @vitest-environment node
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ isAuthenticated: vi.fn(), fetchAuthQuery: vi.fn(), fetchAuthMutation: vi.fn(), after: vi.fn(), worker: vi.fn() }));
vi.mock("@/lib/auth-server", () => mocks);
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/source-verification/reviewed-employment-job-worker", () => ({ runReviewedEmploymentJob: mocks.worker }));
import { GET, maxDuration } from "./route";
import { POST as cancel } from "./cancel/route";

const projection = { jobId: "saved-job", externalId: "existing-chat", userClientId: "user-message", assistantClientId: "assistant-message", question: "Can I refuse overtime?", status: "running", progress: "consent", createdAt: 1000, verificationDeadlineAt: 241000, terminalDeadlineAt: 271000, errorReason: null };
function getRequest(query = "chat=existing-chat", headers?: HeadersInit) { return new Request(`http://localhost:3000/api/chat/background?${query}`, { headers }); }
function cancelRequest(body = JSON.stringify({ jobId: "saved-job" }), headers: HeadersInit = {}) { return new Request("http://localhost:3000/api/chat/background/cancel", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json", ...headers }, body }); }
beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries({ NODE_ENV: "development", LOCAL_REVIEWED_EMPLOYMENT_ENABLED: "1", LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED: "1", LOCAL_REVIEWED_EMPLOYMENT_SPLIT_ENABLED: "1", LOCAL_REVIEWED_EMPLOYMENT_BACKGROUND_ENABLED: "1", CONVEX_DEPLOYMENT: "dev:adventurous-hummingbird-244", NEXT_PUBLIC_CONVEX_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.cloud", NEXT_PUBLIC_CONVEX_SITE_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.site" })) vi.stubEnv(key, value);
  vi.stubEnv("VERCEL", undefined);
  mocks.isAuthenticated.mockResolvedValue(true); mocks.fetchAuthQuery.mockResolvedValue(projection);
  mocks.fetchAuthMutation.mockResolvedValue({ ...projection, status: "cancelled", errorReason: "cancelled" });
  mocks.worker.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("saved reviewed background job API", () => {
  it.each([undefined, "0", "true"])("returns disabled before authentication or backend query when the flag is %s", async flag => {
    vi.stubEnv("LOCAL_REVIEWED_EMPLOYMENT_ENABLED", flag);
    const response = await GET(getRequest());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ enabled: false, job: null });
    expect(mocks.isAuthenticated).not.toHaveBeenCalled(); expect(mocks.fetchAuthQuery).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });
  it.each(["NODE_ENV", "CONVEX_DEPLOYMENT", "VERCEL"])("does not touch new backend refs outside the exact gate (%s)", async key => {
    vi.stubEnv(key, key === "VERCEL" ? "1" : "off");
    expect(await (await GET(getRequest())).json()).toEqual({ enabled: false, job: null });
    expect(mocks.fetchAuthQuery).not.toHaveBeenCalled();
  });
  it("allows a native authenticated same-origin GET without an Origin header", async () => {
    const response = await GET(getRequest("chat=existing-chat", { "sec-fetch-site": "same-origin" }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ enabled: true, job: projection });
    expect(response.headers.get("cache-control")).toContain("no-store");
    const [reference, args] = mocks.fetchAuthQuery.mock.calls[0];
    expect(getFunctionName(reference)).toBe("reviewedEmploymentJobs:getForChat"); expect(args).toEqual({ externalId: "existing-chat" });
  });
  it("requires authentication for enabled progress reads", async () => {
    mocks.isAuthenticated.mockResolvedValue(false);
    expect((await GET(getRequest())).status).toBe(401); expect(mocks.fetchAuthQuery).not.toHaveBeenCalled();
  });
  it("reads the exact saved pending job when an ID is known", async () => {
    const response = await GET(getRequest("chat=existing-chat&job=saved-job"));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ enabled: true, job: projection });
    expect(mocks.fetchAuthQuery.mock.calls[0][1]).toEqual({ externalId: "existing-chat", jobId: "saved-job" });
    expect(mocks.fetchAuthMutation).not.toHaveBeenCalled(); expect(mocks.after).not.toHaveBeenCalled();
  });
  it("closes an exact-ID projection mismatch without starting work", async () => {
    mocks.fetchAuthQuery.mockResolvedValue({ ...projection, jobId: "different-job", status: "queued", progress: "queued" });
    const response = await GET(getRequest("chat=existing-chat&job=saved-job"));
    expect(response.status).toBe(500); expect(await response.text()).not.toContain("different-job");
    expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.fetchAuthMutation).not.toHaveBeenCalled();
  });
  it("returns no projection for an unavailable exact pending ID", async () => {
    mocks.fetchAuthQuery.mockResolvedValue(null);
    expect(await (await GET(getRequest("chat=existing-chat&job=missing-job"))).json()).toEqual({ enabled: true, job: null });
    expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.fetchAuthMutation).not.toHaveBeenCalled();
  });
  it("recovers an authenticated saved queued job after the progress response", async () => {
    const queued = { ...projection, status: "queued", progress: "queued" };
    mocks.fetchAuthQuery.mockResolvedValue(queued);
    const response = await GET(getRequest());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ enabled: true, job: queued });
    expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.worker).toHaveBeenCalledWith("saved-job");
    expect(maxDuration).toBe(300);
  });
  it.each(["running", "succeeded", "blocked", "cancelled", "expired"])("does not relaunch a %s job", async status => {
    mocks.fetchAuthQuery.mockResolvedValue({ ...projection, status });
    expect((await GET(getRequest("chat=existing-chat&job=saved-job"))).status).toBe(200);
    expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.worker).not.toHaveBeenCalled();
  });
  it("lets repeated queued reads request only worker claims without resubmitting saved work", async () => {
    mocks.fetchAuthQuery.mockResolvedValue({ ...projection, status: "queued", progress: "queued" });
    expect((await GET(getRequest())).status).toBe(200);
    expect((await GET(getRequest())).status).toBe(200);
    expect(mocks.after).toHaveBeenCalledTimes(2);
    expect(mocks.fetchAuthMutation).not.toHaveBeenCalled();
    for (const [callback] of mocks.after.mock.calls) await callback();
    expect(mocks.worker.mock.calls).toEqual([["saved-job"], ["saved-job"]]);
  });
  it("bounds stalled recovery authentication at 25 seconds and ignores a late successful sign-in", async () => {
    vi.useFakeTimers();
    let finishAuth!: (value: boolean) => void;
    mocks.isAuthenticated.mockReturnValueOnce(new Promise(resolve => { finishAuth = resolve; }));
    let settled = false;
    const pending = GET(getRequest()).then(response => { settled = true; return response; });
    await vi.advanceTimersByTimeAsync(24_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(settled).toBe(true);
    expect((await pending).status).toBe(500);
    finishAuth(true); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetchAuthQuery).not.toHaveBeenCalled(); expect(mocks.after).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ignores a queued query result arriving after 25 seconds and lets a fresh read recover it", async () => {
    vi.useFakeTimers();
    const queued = { ...projection, status: "queued", progress: "queued" };
    let finishQuery!: (value: unknown) => void;
    mocks.fetchAuthQuery.mockReturnValueOnce(new Promise(resolve => { finishQuery = resolve; })).mockResolvedValueOnce(queued);
    let settled = false;
    const pending = GET(getRequest()).then(response => { settled = true; return response; });
    await vi.advanceTimersByTimeAsync(24_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(settled).toBe(true);
    expect((await pending).status).toBe(500);
    finishQuery(queued); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.after).not.toHaveBeenCalled();
    expect((await GET(getRequest())).status).toBe(200);
    expect(mocks.after).toHaveBeenCalledTimes(1); expect(mocks.fetchAuthMutation).not.toHaveBeenCalled();
  });
  it("rejects recovery when monotonic elapsed time exceeds 25 seconds before launching queued work", async () => {
    vi.useFakeTimers();
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(0);
    mocks.fetchAuthQuery.mockImplementationOnce(async () => { monotonic.mockReturnValue(26_000); return { ...projection, status: "queued", progress: "queued" }; });
    expect((await GET(getRequest())).status).toBe(500);
    expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.worker).not.toHaveBeenCalled();
  });
  it.each(["chat=", "chat=one&chat=two", "chat=existing-chat&extra=one", `chat=${"a".repeat(201)}`,
    "chat=existing-chat&job=", "chat=existing-chat&job=one&job=two", `chat=existing-chat&job=${"j".repeat(201)}`, "job=saved-job"])("rejects invalid chat query %s", async query => {
    expect((await GET(getRequest(query))).status).toBe(400); expect(mocks.fetchAuthQuery).not.toHaveBeenCalled();
  });
  it.each([new Headers({ origin: "https://foreign.example" }), new Headers({ "sec-fetch-site": "cross-site" })])("blocks foreign reads %o before backend query", async headers => {
    expect(await (await GET(getRequest("chat=existing-chat", headers))).json()).toEqual({ enabled: false, job: null });
    expect(mocks.fetchAuthQuery).not.toHaveBeenCalled();
  });
  it("returns no job when the authenticated owner has no saved job", async () => {
    mocks.fetchAuthQuery.mockResolvedValue(null);
    expect(await (await GET(getRequest())).json()).toEqual({ enabled: true, job: null });
  });
  it("closes malformed or failed backend reads without leaking private details", async () => {
    mocks.fetchAuthQuery.mockResolvedValueOnce({ ...projection, candidate: "private draft" }).mockRejectedValueOnce(new Error("private backend detail"));
    for (let i = 0; i < 2; i++) {
      const response = await GET(getRequest()); expect(response.status).toBe(500); expect(await response.text()).not.toMatch(/private draft|private backend detail/);
    }
  });
  it("cancels through authenticated owner mutation and returns the closed projection", async () => {
    const response = await cancel(cancelRequest());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ job: { ...projection, status: "cancelled", errorReason: "cancelled" } });
    const [reference, args] = mocks.fetchAuthMutation.mock.calls[0]; expect(getFunctionName(reference)).toBe("reviewedEmploymentJobs:cancel"); expect(args).toEqual({ jobId: "saved-job" });
  });
  it("retains cancellation when background work is disabled", async () => {
    vi.stubEnv("LOCAL_REVIEWED_EMPLOYMENT_BACKGROUND_ENABLED", undefined);
    expect((await cancel(cancelRequest())).status).toBe(200); expect(mocks.fetchAuthMutation).toHaveBeenCalledTimes(1);
  });
  it.each(["LOCAL_REVIEWED_EMPLOYMENT_BACKGROUND_ENABLED", "LOCAL_REVIEWED_EMPLOYMENT_SPLIT_ENABLED", "LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED"])("retains local read and cancellation after %s is disabled without starting queued work", async flag => {
    vi.stubEnv(flag, "0");
    mocks.fetchAuthQuery.mockResolvedValue({ ...projection, status: "queued", progress: "queued" });
    expect(await (await GET(getRequest())).json()).toMatchObject({ enabled: true, job: { status: "queued" } });
    expect((await cancel(cancelRequest())).status).toBe(200);
    expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.worker).not.toHaveBeenCalled();
  });
  it("retains production owner read and cancellation during execution rollback without launching a queued job", async () => {
    for (const [key, value] of Object.entries({ NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production",
      NEXT_PUBLIC_CONVEX_URL: "https://loyal-koala-720.eu-west-1.convex.cloud", NEXT_PUBLIC_CONVEX_SITE_URL: "https://loyal-koala-720.eu-west-1.convex.site",
      REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED: "0", REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED: "0" })) vi.stubEnv(key, value);
    vi.stubEnv("CONVEX_DEPLOYMENT", undefined);
    mocks.fetchAuthQuery.mockResolvedValue({ ...projection, status: "queued", progress: "queued" });
    const response = await GET(new Request("https://lawoftheland.vercel.app/api/chat/background?chat=existing-chat"));
    expect(await response.json()).toMatchObject({ enabled: true, job: { status: "queued" } });
    const cancelled = await cancel(new Request("https://lawoftheland.vercel.app/api/chat/background/cancel", { method: "POST", headers: { origin: "https://lawoftheland.vercel.app" }, body: JSON.stringify({ jobId: "saved-job" }) }));
    expect(cancelled.status).toBe(200); expect(mocks.fetchAuthMutation).toHaveBeenCalledTimes(1);
    expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.worker).not.toHaveBeenCalled();
  });
  it("can recover unclaimed production work after admission is disabled while execution remains enabled", async () => {
    for (const [key, value] of Object.entries({ NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production",
      NEXT_PUBLIC_CONVEX_URL: "https://loyal-koala-720.eu-west-1.convex.cloud", NEXT_PUBLIC_CONVEX_SITE_URL: "https://loyal-koala-720.eu-west-1.convex.site",
      REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED: "0", REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED: "1" })) vi.stubEnv(key, value);
    vi.stubEnv("CONVEX_DEPLOYMENT", undefined);
    mocks.fetchAuthQuery.mockResolvedValue({ ...projection, status: "queued", progress: "queued" });
    expect((await GET(new Request("https://lawoftheland.vercel.app/api/chat/background?chat=existing-chat"))).status).toBe(200);
    expect(mocks.after).toHaveBeenCalledTimes(1); expect(mocks.fetchAuthMutation).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0][0](); expect(mocks.worker).toHaveBeenCalledWith("saved-job");
  });
  it("does not take over claimed production work after host loss and exposes its backend expiry", async () => {
    for (const [key, value] of Object.entries({ NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production",
      NEXT_PUBLIC_CONVEX_URL: "https://loyal-koala-720.eu-west-1.convex.cloud", NEXT_PUBLIC_CONVEX_SITE_URL: "https://loyal-koala-720.eu-west-1.convex.site",
      REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED: "1", REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED: "1" })) vi.stubEnv(key, value);
    vi.stubEnv("CONVEX_DEPLOYMENT", undefined);
    mocks.fetchAuthQuery.mockResolvedValueOnce(projection).mockResolvedValueOnce({ ...projection, status: "expired", errorReason: "deadline_exceeded" });
    const request = () => new Request("https://lawoftheland.vercel.app/api/chat/background?chat=existing-chat&job=saved-job");
    expect(await (await GET(request())).json()).toMatchObject({ enabled: true, job: { jobId: "saved-job", status: "running" } });
    expect(await (await GET(request())).json()).toMatchObject({ enabled: true, job: { jobId: "saved-job", status: "expired" } });
    expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.worker).not.toHaveBeenCalled(); expect(mocks.fetchAuthMutation).not.toHaveBeenCalled();
  });
  it("requires authentication and original same-origin header before cancellation", async () => {
    expect((await cancel(cancelRequest(undefined, { origin: "https://foreign.example" }))).status).toBe(403);
    mocks.isAuthenticated.mockResolvedValue(false);
    expect((await cancel(cancelRequest())).status).toBe(401); expect(mocks.fetchAuthMutation).not.toHaveBeenCalled();
  });
  it.each(["not-json", JSON.stringify({ jobId: "" }), JSON.stringify({ jobId: "saved-job", extra: "private" }), JSON.stringify({ jobId: "j".repeat(201) }), "x".repeat(5000)])("rejects invalid cancellation body %s", async body => {
    expect((await cancel(cancelRequest(body))).status).toBe(400); expect(mocks.fetchAuthMutation).not.toHaveBeenCalled();
  });
  it("closes cancellation errors and private projections", async () => {
    mocks.fetchAuthMutation.mockRejectedValueOnce(new Error("private cancellation detail")).mockResolvedValueOnce({ ...projection, serviceProof: "private proof" });
    for (let i = 0; i < 2; i++) { const response = await cancel(cancelRequest()); expect(response.status).toBe(500); expect(await response.text()).not.toMatch(/private cancellation detail|private proof/); }
  });
});
