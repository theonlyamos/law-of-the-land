import { makeFunctionReference } from "convex/server";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileRecoveredDocument } from "./geminiRecoveryActions";
import { verifyRecoveredGeminiDocument } from "./integrations/geminiFailedDocumentObservation";

vi.mock("./integrations/geminiFailedDocumentObservation", () => ({ verifyRecoveredGeminiDocument: vi.fn() }));
vi.mock("./integrations/geminiActiveDocument", () => ({ verifyActiveGeminiDocument: vi.fn() }));

const jobId = "job-id" as Id<"integrationJobs">;
const args = { jobId, reason: "Finish the once-failed first publication that Gemini made active", idempotencyKey: "recovered-fixture" };
const result = { status: "succeeded" as const, jobId, correlationId: "recovery-correlation" };
const failure = { ...result, status: "failed" as const };
const failedDocumentReference = `sha256:${"c".repeat(64)}`;
const claim = {
  kind: "claimed" as const,
  operationId: "operation-id" as Id<"adminOperations">,
  leaseToken: "private-lease-token",
  binding: "b".repeat(64),
  jurisdictionId: "jurisdiction-id" as Id<"jurisdictions">,
  failedDocumentReference,
  target: {
    operationName: "fileSearchStores/fixture/upload/operations/retained",
    storeName: "fileSearchStores/fixture",
    metadata: { environment: "production", jurisdiction_id: "jurisdiction-id", resource_id: "resource-id",
      version_id: "version-id", version_number: "1", sha256: "a".repeat(64) },
  },
};
const proof = { documentName: "fileSearchStores/fixture/documents/once-failed", verifiedAt: 1_790_000_000_000 };
const boundAttempt = { operationId: claim.operationId, leaseToken: claim.leaseToken, binding: claim.binding, jurisdictionId: claim.jurisdictionId };
const claimRef = makeFunctionReference<"mutation">("admin/geminiRecoveredRecovery:claimRecoveredDocumentRecovery");
const completeRef = makeFunctionReference<"mutation">("admin/geminiRecoveredRecovery:completeRecoveredDocumentRecovery");
const abortRef = makeFunctionReference<"mutation">("admin/geminiRecoveredRecovery:abortRecoveredDocumentRecovery");

function actionContext() {
  return {
    runMutation: vi.fn(async (_ref: unknown, _args: unknown): Promise<unknown> => claim),
    runQuery: vi.fn(() => { throw new Error("Unexpected query"); }),
    runAction: vi.fn(() => { throw new Error("Unexpected action"); }),
    scheduler: { runAfter: vi.fn(() => { throw new Error("Unexpected schedule"); }) },
    storage: { getUrl: vi.fn(() => { throw new Error("Unexpected storage access"); }) },
  };
}
const handler = (reconcileRecoveredDocument as unknown as {
  _handler: (ctx: ActionCtx, input: typeof args) => Promise<unknown>;
})._handler;
const invoke = (ctx: ReturnType<typeof actionContext>) => handler(ctx as unknown as ActionCtx, args);

beforeEach(() => {
  vi.stubEnv("GOOGLE_AI_API_KEY", "server-only-test-key");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected direct provider request"); }));
  vi.mocked(verifyRecoveredGeminiDocument).mockResolvedValue(proof);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe("internal recovered-document recovery action", () => {
  it("verifies the claimed failed document reference and completes with fresh proof", async () => {
    expect(reconcileRecoveredDocument).toHaveProperty("isInternal", true);
    const ctx = actionContext();
    ctx.runMutation.mockResolvedValueOnce(claim).mockResolvedValueOnce(result);
    const actual = await invoke(ctx);
    expect(actual).toEqual(result);
    expect(ctx.runMutation).toHaveBeenNthCalledWith(1, claimRef, args);
    expect(verifyRecoveredGeminiDocument).toHaveBeenCalledExactlyOnceWith(claim.target, failedDocumentReference, "server-only-test-key");
    expect(ctx.runMutation).toHaveBeenNthCalledWith(2, completeRef, { ...boundAttempt, ...proof });
    expect(JSON.stringify(actual)).not.toContain(claim.leaseToken);
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });

  it("returns a saved receipt without contacting Gemini", async () => {
    const ctx = actionContext();
    ctx.runMutation.mockResolvedValueOnce({ kind: "completed", result: failure });
    expect(await invoke(ctx)).toEqual(failure);
    expect(verifyRecoveredGeminiDocument).not.toHaveBeenCalled();
  });

  it("rejects missing credentials before claiming", async () => {
    vi.stubEnv("GOOGLE_AI_API_KEY", "");
    const ctx = actionContext();
    await expect(invoke(ctx)).rejects.toThrow("GEMINI_RECOVERED_DOCUMENT_RECOVERY_NOT_CONFIGURED");
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("aborts its exact claim when provider proof fails", async () => {
    vi.mocked(verifyRecoveredGeminiDocument).mockRejectedValueOnce(new Error("server-only-test-key private provider response"));
    const ctx = actionContext();
    ctx.runMutation.mockResolvedValueOnce(claim).mockResolvedValueOnce(failure);
    expect(await invoke(ctx)).toEqual(failure);
    expect(ctx.runMutation).toHaveBeenCalledTimes(2);
    expect(ctx.runMutation).toHaveBeenNthCalledWith(2, abortRef, boundAttempt);
    expect(JSON.stringify(ctx.runMutation.mock.calls)).not.toContain("private provider response");
  });

  it("aborts after guarded completion rejects, and redacts abort failure", async () => {
    const ctx = actionContext();
    ctx.runMutation.mockResolvedValueOnce(claim).mockRejectedValueOnce(new Error("binding changed")).mockResolvedValueOnce(failure);
    expect(await invoke(ctx)).toEqual(failure);
    expect(ctx.runMutation).toHaveBeenNthCalledWith(3, abortRef, boundAttempt);

    vi.mocked(verifyRecoveredGeminiDocument).mockRejectedValueOnce(new Error("private"));
    const second = actionContext();
    second.runMutation.mockResolvedValueOnce(claim).mockRejectedValueOnce(new Error("private abort failure"));
    const error = await invoke(second).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("GEMINI_RECOVERED_DOCUMENT_RECOVERY_FAILED");
    expect((error as Error).message).not.toContain("private");
  });
});
