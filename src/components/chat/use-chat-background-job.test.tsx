import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewedEmploymentJobProjection } from "../../../shared/reviewed-employment-jobs";

const identity = vi.hoisted(() => ({ owner: "owner-1" as string | null }));
vi.mock("@/lib/auth-client", () => ({ authClient: { useSession: () => ({
  data: identity.owner ? { user: { id: identity.owner } } : null, isPending: false, error: null,
}) } }));
import { useChatBackgroundJob } from "./use-chat-background-job";

const job: ReviewedEmploymentJobProjection = { jobId: "job-1", externalId: "chat-1", userClientId: "user-1",
  assistantClientId: "assistant-1", question: "Written consent?", status: "running", progress: "consent",
  createdAt: 1, verificationDeadlineAt: 240001, terminalDeadlineAt: 270001, errorReason: null };
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const observe = (pendingJobId: string | null = null) => renderHook(() => useChatBackgroundJob({
  chatId: "chat-1", isAuthenticated: Boolean(identity.owner), pendingJobId,
}));
beforeEach(() => { identity.owner = "owner-1"; vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("background job observation", () => {
  it("classifies an unknown-capability recovery using a fresh disabled capability read", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ enabled: false, job: null })));
    const recovery = { userClientId: job.userClientId, assistantClientId: job.assistantClientId,
      requiresCapability: true, startedAt: Date.now(), startedMonotonic: performance.now() };
    const observed = renderHook(() => useChatBackgroundJob({ chatId: job.externalId,
      isAuthenticated: true, pendingJobId: null, recoverySubmission: recovery }));
    await flush();
    expect(observed.result.current).toMatchObject({ enabled: false, isPending: false, uncertain: false, recoveryOutcome: "ordinary_error" });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a known-capability recovery uncertain if capability becomes disabled", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ enabled: false, job: null })));
    const recovery = { userClientId: job.userClientId, assistantClientId: job.assistantClientId,
      requiresCapability: false, startedAt: Date.now(), startedMonotonic: performance.now() };
    const observed = renderHook(() => useChatBackgroundJob({ chatId: job.externalId,
      isAuthenticated: true, pendingJobId: null, recoverySubmission: recovery }));
    await flush(); expect(observed.result.current).toMatchObject({ isPending: true, uncertain: true, recoveryOutcome: null });
  });

  it("retains a freshly confirmed capability if it is disabled during the same unknown submission", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ enabled: true, job: null }))
      .mockResolvedValue(Response.json({ enabled: false, job: null })));
    const recovery = { userClientId: job.userClientId, assistantClientId: job.assistantClientId,
      requiresCapability: true, startedAt: Date.now(), startedMonotonic: performance.now() };
    const observed = renderHook(() => useChatBackgroundJob({ chatId: job.externalId,
      isAuthenticated: true, pendingJobId: null, recoverySubmission: recovery }));
    await flush(); await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(observed.result.current).toMatchObject({ enabled: false, isPending: true, uncertain: true, recoveryOutcome: null });
  });

  it("ends unknown recovery within 300 seconds despite wall-clock rollback and clears a queued Stop", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ enabled: true, job: null })));
    const recovery = { userClientId: job.userClientId, assistantClientId: job.assistantClientId,
      requiresCapability: false, startedAt: Date.now(), startedMonotonic: performance.now() };
    const observed = renderHook(() => useChatBackgroundJob({ chatId: job.externalId,
      isAuthenticated: true, pendingJobId: null, recoverySubmission: recovery }));
    await flush(); await act(async () => { await observed.result.current.cancel(); });
    vi.setSystemTime(Date.now() - 3600000);
    await act(async () => { await vi.advanceTimersByTimeAsync(299999); });
    expect(observed.result.current.isPending).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(observed.result.current).toMatchObject({ isPending: false, uncertain: false, cancelling: false, recoveryOutcome: "expired" });
    const reads = vi.mocked(fetch).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(fetch).toHaveBeenCalledTimes(reads);
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });

  it("bounds unknown recovery even when a later observation never responds", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ enabled: true, job: null }))
      .mockReturnValue(new Promise<Response>(() => undefined)));
    const recovery = { userClientId: job.userClientId, assistantClientId: job.assistantClientId,
      requiresCapability: false, startedAt: Date.now(), startedMonotonic: performance.now() };
    const observed = renderHook(() => useChatBackgroundJob({ chatId: job.externalId,
      isAuthenticated: true, pendingJobId: null, recoverySubmission: recovery }));
    await flush(); await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
    expect(observed.result.current).toMatchObject({ isPending: false, recoveryOutcome: "expired" });
    expect(vi.mocked(fetch).mock.calls[1][1]?.signal?.aborted).toBe(true);
  });

  it("never returns the old recovery failure for a new turn in the same chat", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ enabled: true, job: null })));
    let recovery = { userClientId: job.userClientId, assistantClientId: job.assistantClientId,
      requiresCapability: false, startedAt: Date.now(), startedMonotonic: performance.now() };
    const outcomes: Array<string | null> = [];
    const observed = renderHook(() => {
      const result = useChatBackgroundJob({ chatId: job.externalId, isAuthenticated: true,
        pendingJobId: null, recoverySubmission: recovery });
      outcomes.push(result.recoveryOutcome);
      return result;
    });
    await flush(); await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
    expect(observed.result.current.recoveryOutcome).toBe("expired");
    recovery = { ...recovery, userClientId: "next-user", assistantClientId: "next-assistant",
      startedAt: Date.now(), startedMonotonic: performance.now() };
    outcomes.length = 0; observed.rerender();
    expect(outcomes.every(outcome => outcome === null)).toBe(true);
  });

  it("switches a matching native job to its own lifecycle before the unknown-recovery deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ enabled: true, job })));
    const recovery = { userClientId: job.userClientId, assistantClientId: job.assistantClientId,
      requiresCapability: false, startedAt: Date.now(), startedMonotonic: performance.now() };
    const observed = renderHook(() => useChatBackgroundJob({ chatId: job.externalId,
      isAuthenticated: true, pendingJobId: null, recoverySubmission: recovery }));
    await flush(); await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
    expect(observed.result.current).toMatchObject({ job, isPending: true, recoveryOutcome: null });
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });

  it("clears Stop state when native status becomes terminal while its cancel response is stalled", async () => {
    let nativeJob = job;
    let pendingId: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/chat/background/cancel"
      ? new Promise<Response>(() => undefined) : Response.json({ enabled: true, job: nativeJob })));
    const observed = renderHook(() => useChatBackgroundJob({ chatId: job.externalId, isAuthenticated: true, pendingJobId: pendingId }));
    await flush(); act(() => { void observed.result.current.cancel(); });
    nativeJob = { ...job, status: "cancelled", errorReason: "cancelled" };
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(observed.result.current).toMatchObject({ isPending: false, cancelling: false });
    nativeJob = { ...job, jobId: "job-next", userClientId: "user-next", assistantClientId: "assistant-next" };
    pendingId = nativeJob.jobId; observed.rerender(); await flush();
    expect(observed.result.current.cancelling).toBe(false);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/chat/background/cancel")).toHaveLength(1);
  });

  it("checks disabled capability once without starting any job or polling", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ enabled: false, job: null })));
    const observed = observe(); await flush();
    expect(observed.result.current.checking).toBe(false); expect(observed.result.current.isPending).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe("GET");
  });

  it("keeps an acknowledged job pending when its status cannot yet be found", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ enabled: true, job: null })));
    const observed = observe("job-1"); await flush();
    expect(observed.result.current.isPending).toBe(true); expect(observed.result.current.uncertain).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });

  it("retains a known pending question on status errors and only retries observation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ enabled: true, job }))
      .mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status: 503 }))
      .mockResolvedValue(Response.json({ enabled: true, job: { ...job, status: "expired", errorReason: "deadline_exceeded" } })));
    const observed = observe(); await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(observed.result.current.job?.question).toBe(job.question);
    expect(observed.result.current.uncertain).toBe(true); expect(observed.result.current.isPending).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(observed.result.current.job?.status).toBe("expired"); expect(observed.result.current.isPending).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });

  it.each([null, "owner-2"])("clears the old projection when ownership changes to %s", async nextOwner => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ enabled: true, job }))
      .mockReturnValue(new Promise<Response>(() => undefined)));
    const observed = observe(); await flush();
    const initialSignal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    identity.owner = nextOwner; observed.rerender();
    expect(observed.result.current.job).toBeNull(); expect(initialSignal?.aborted).toBe(true);
    expect(vi.mocked(fetch).mock.calls.every(([url]) => url !== "/api/chat/background/cancel")).toBe(true);
  });

  it("ignores a late status response from the previous owner", async () => {
    let finishOld!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(new Promise<Response>(resolve => { finishOld = resolve; }))
      .mockResolvedValue(Response.json({ enabled: true, job: null })));
    const observed = observe(); identity.owner = "owner-2"; observed.rerender(); await flush();
    await act(async () => { finishOld(Response.json({ enabled: true, job })); });
    expect(observed.result.current.job).toBeNull(); expect(observed.result.current.uncertain).toBe(false);
  });

  it("limits a received projection to the public fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ enabled: true,
      job: { ...job, candidate: "Private candidate", workerId: "worker-secret", jwt: "secret" } })));
    const observed = observe(); await flush(); expect(observed.result.current.job).toEqual(job);
  });

  it.each([{ ...job, status: "unexpected" }, { ...job, progress: "raw_provider_stage" },
    { ...job, errorReason: "private_error_text" }, { ...job, externalId: "another-chat" }])("treats a malformed projection as uncertain", async invalid => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ enabled: true, job: invalid })));
    const observed = observe(job.jobId); await flush();
    expect(observed.result.current.job).toBeNull(); expect(observed.result.current.uncertain).toBe(true);
    expect(observed.result.current.isPending).toBe(true);
  });
});


describe("ordinary chats without an accepted background job", () => {
  it.each(["network", "status", "malformed"])("does not block or poll after an initial %s observation failure", async failure => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (failure === "network") throw new TypeError("Status network failure");
      if (failure === "status") return Response.json({ error: "Unavailable" }, { status: 503 });
      return Response.json({ enabled: true, job: { ...job, externalId: "another-chat" } });
    }));
    const observed = observe(); await flush();
    expect(observed.result.current).toMatchObject({ checking: false, uncertain: false, isPending: false, job: null, enabled: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});


describe("bounded initial background observation", () => {
  it.each([[false, "fetch"], [false, "body"], [true, "fetch"], [true, "body"]] as const)(
    "bounds a stalled initial lookup with known pending=%s during %s", async (knownPending, stalled) => {
      let statusSignal: AbortSignal | undefined;
      vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => {
        statusSignal = options?.signal as AbortSignal;
        if (stalled === "fetch") return new Promise<Response>(() => undefined);
        return { ok: true, json: () => new Promise(() => undefined) } as Response;
      }));
      const observed = observe(knownPending ? job.jobId : null); await flush();
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(observed.result.current).toMatchObject({ checking: false, uncertain: knownPending, isPending: knownPending, job: null });
      expect(statusSignal?.aborted).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(fetch).toHaveBeenCalledTimes(knownPending ? 2 : 1);
    });
});
