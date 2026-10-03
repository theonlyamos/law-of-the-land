import { makeFunctionReference } from "convex/server";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileActiveDocument } from "./geminiRecoveryActions";
import { verifyActiveGeminiDocument } from "./integrations/geminiActiveDocument";

vi.mock("./integrations/geminiActiveDocument", () => ({
  verifyActiveGeminiDocument: vi.fn(),
}));

const jobId = "job-id" as Id<"integrationJobs">;
const args = { jobId, reason: "Verify and reconcile the retained active document", idempotencyKey: "recovery-fixture" };
const result = { status: "succeeded" as const, jobId, correlationId: "recovery-correlation" };
const failure = { ...result, status: "failed" as const };
const claim = {
  kind: "claimed" as const,
  operationId: "operation-id" as Id<"adminOperations">,
  leaseToken: "private-lease-token",
  binding: "b".repeat(64),
  jurisdictionId: "jurisdiction-id" as Id<"jurisdictions">,
  target: {
    operationName: "fileSearchStores/fixture/upload/operations/retained",
    storeName: "fileSearchStores/fixture",
    metadata: {
      environment: "production", jurisdiction_id: "jurisdiction-id", resource_id: "resource-id",
      version_id: "version-id", version_number: "1", sha256: "a".repeat(64),
    },
  },
};
const proof = { documentName: "fileSearchStores/fixture/documents/active", verifiedAt: 1_790_000_000_000 };
const boundAttempt = {
  operationId: claim.operationId, leaseToken: claim.leaseToken,
  binding: claim.binding, jurisdictionId: claim.jurisdictionId,
};
const claimRef = makeFunctionReference<"mutation">("admin/geminiRecovery:claimActiveDocumentRecovery");
const completeRef = makeFunctionReference<"mutation">("admin/geminiRecovery:completeActiveDocumentRecovery");
const abortRef = makeFunctionReference<"mutation">("admin/geminiRecovery:abortActiveDocumentRecovery");

function actionContext() {
  return {
    runMutation: vi.fn(async (_ref: unknown, _args: unknown): Promise<unknown> => claim),
    runQuery: vi.fn(() => { throw new Error("Unexpected query"); }),
    runAction: vi.fn(() => { throw new Error("Unexpected action"); }),
    scheduler: { runAfter: vi.fn(() => { throw new Error("Unexpected schedule"); }) },
    storage: { getUrl: vi.fn(() => { throw new Error("Unexpected storage access"); }) },
  };
}

// Convex exposes this handler to its test harness, but omits it from the public type.
const handler = (reconcileActiveDocument as unknown as {
  _handler: (ctx: ActionCtx, input: typeof args) => Promise<unknown>;
})._handler;
const invoke = (ctx: ReturnType<typeof actionContext>) => handler(ctx as unknown as ActionCtx, args);

beforeEach(() => {
  vi.stubEnv("GOOGLE_AI_API_KEY", "server-only-test-key");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected direct provider request"); }));
  vi.mocked(verifyActiveGeminiDocument).mockResolvedValue(proof);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe("internal active-document recovery action", () => {
  it("passes only fresh provider proof and the claimed attempt to guarded completion", async () => {
    expect(reconcileActiveDocument).toHaveProperty("isInternal", true);
    const ctx = actionContext();
    ctx.runMutation.mockResolvedValueOnce(claim).mockResolvedValueOnce(result);

    const actual = await invoke(ctx);
    expect(actual).toEqual(result);

    expect(ctx.runMutation).toHaveBeenCalledTimes(2);
    expect(ctx.runMutation).toHaveBeenNthCalledWith(1, claimRef, args);
    expect(verifyActiveGeminiDocument).toHaveBeenCalledExactlyOnceWith(claim.target, "server-only-test-key");
    expect(ctx.runMutation).toHaveBeenNthCalledWith(2, completeRef, { ...boundAttempt, ...proof });
    expect(ctx.runMutation.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(verifyActiveGeminiDocument).mock.invocationCallOrder[0]);
    expect(vi.mocked(verifyActiveGeminiDocument).mock.invocationCallOrder[0]).toBeLessThan(ctx.runMutation.mock.invocationCallOrder[1]);
    expect(JSON.stringify(actual)).not.toContain("server-only-test-key");
    expect(JSON.stringify(actual)).not.toContain(claim.leaseToken);
    expect(JSON.stringify(actual)).not.toContain(proof.documentName);
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.runQuery).not.toHaveBeenCalled();
    expect(ctx.runAction).not.toHaveBeenCalled();
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    expect(ctx.storage.getUrl).not.toHaveBeenCalled();
  });

  it.each([result, failure])("returns a completed %s receipt without provider access or another mutation", async (savedResult) => {
    const ctx = actionContext();
    ctx.runMutation.mockResolvedValueOnce({ kind: "completed", result: savedResult });
    expect(await invoke(ctx)).toEqual(savedResult);
    expect(ctx.runMutation).toHaveBeenCalledExactlyOnceWith(claimRef, args);
    expect(verifyActiveGeminiDocument).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])("rejects missing/empty server credentials before taking a lease (%s)", async (apiKey) => {
    vi.stubEnv("GOOGLE_AI_API_KEY", apiKey);
    const ctx = actionContext();
    await expect(invoke(ctx)).rejects.toThrow("GEMINI_ACTIVE_DOCUMENT_RECOVERY_NOT_CONFIGURED");
    expect(ctx.runMutation).not.toHaveBeenCalled();
    expect(verifyActiveGeminiDocument).not.toHaveBeenCalled();
  });

  it("blocks configured E2E stubs before claiming or contacting Gemini", async () => {
    vi.stubEnv("ADMIN_E2E_FIXTURE_MODE", "true");
    vi.stubEnv("ADMIN_E2E_TARGET_ENV", "test");
    vi.stubEnv("ADMIN_E2E_ISOLATED_TARGET_MARKER", "isolated-admin-e2e");
    vi.stubEnv("ADMIN_E2E_PROVIDER_STUB_MODE", "true");
    const ctx = actionContext();
    await expect(invoke(ctx)).rejects.toThrow("GEMINI_ACTIVE_DOCUMENT_RECOVERY_UNAVAILABLE_IN_E2E");
    expect(ctx.runMutation).not.toHaveBeenCalled();
    expect(verifyActiveGeminiDocument).not.toHaveBeenCalled();
  });

  it("fails closed for partial E2E configuration before claiming", async () => {
    vi.stubEnv("ADMIN_E2E_FIXTURE_MODE", "true");
    const ctx = actionContext();
    await expect(invoke(ctx)).rejects.toThrow("E2E_PROVIDER_ISOLATION_MISCONFIGURED");
    expect(ctx.runMutation).not.toHaveBeenCalled();
    expect(verifyActiveGeminiDocument).not.toHaveBeenCalled();
  });

  it("preserves claim rejection without contacting Gemini or aborting an unclaimed attempt", async () => {
    const ctx = actionContext();
    ctx.runMutation.mockRejectedValueOnce(new Error("RECOVERY_TARGET_INVALID"));
    await expect(invoke(ctx)).rejects.toThrow("RECOVERY_TARGET_INVALID");
    expect(ctx.runMutation).toHaveBeenCalledExactlyOnceWith(claimRef, args);
    expect(verifyActiveGeminiDocument).not.toHaveBeenCalled();
  });

  it("aborts its exact claim once after provider proof fails without forwarding the provider error", async () => {
    vi.mocked(verifyActiveGeminiDocument).mockRejectedValueOnce(new Error("server-only-test-key private provider response"));
    const ctx = actionContext();
    ctx.runMutation.mockResolvedValueOnce(claim).mockResolvedValueOnce(failure);
    const actual = await invoke(ctx);
    expect(actual).toEqual(failure);
    expect(ctx.runMutation).toHaveBeenCalledTimes(2);
    expect(ctx.runMutation).toHaveBeenNthCalledWith(2, abortRef, boundAttempt);
    expect(JSON.stringify(actual)).not.toContain("server-only-test-key");
    expect(JSON.stringify(ctx.runMutation.mock.calls)).not.toContain("private provider response");
    expect(JSON.stringify(ctx.runMutation.mock.calls)).not.toContain(proof.documentName);
  });

  it("aborts its exact claim once after guarded completion rejects stale or changed state", async () => {
    const ctx = actionContext();
    ctx.runMutation.mockResolvedValueOnce(claim)
      .mockRejectedValueOnce(new Error("RECOVERY_BINDING_CHANGED private detail"))
      .mockResolvedValueOnce(failure);
    expect(await invoke(ctx)).toEqual(failure);
    expect(ctx.runMutation).toHaveBeenCalledTimes(3);
    expect(ctx.runMutation).toHaveBeenNthCalledWith(2, completeRef, { ...boundAttempt, ...proof });
    expect(ctx.runMutation).toHaveBeenNthCalledWith(3, abortRef, boundAttempt);
  });

  it("returns the persisted success if abort observes completion already committed", async () => {
    const ctx = actionContext();
    ctx.runMutation.mockResolvedValueOnce(claim)
      .mockRejectedValueOnce(new Error("Response delivery failed"))
      .mockResolvedValueOnce(result);
    expect(await invoke(ctx)).toEqual(result);
    expect(ctx.runMutation).toHaveBeenCalledTimes(3);
    expect(verifyActiveGeminiDocument).toHaveBeenCalledTimes(1);
  });

  it("redacts abort failure and does not retry or schedule another attempt", async () => {
    vi.mocked(verifyActiveGeminiDocument).mockRejectedValueOnce(new Error("server-only-test-key private provider response"));
    const ctx = actionContext();
    ctx.runMutation.mockResolvedValueOnce(claim).mockRejectedValueOnce(new Error("private abort failure"));
    const error = await invoke(ctx).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("GEMINI_ACTIVE_DOCUMENT_RECOVERY_FAILED");
    expect((error as Error).message).not.toContain("private");
    expect((error as Error).message).not.toContain("server-only-test-key");
    expect(ctx.runMutation).toHaveBeenCalledTimes(2);
    expect(verifyActiveGeminiDocument).toHaveBeenCalledTimes(1);
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    expect(ctx.runAction).not.toHaveBeenCalled();
  });
});
