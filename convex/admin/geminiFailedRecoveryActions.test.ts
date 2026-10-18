import { makeFunctionReference } from "convex/server";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileFailedDocument } from "./geminiFailedRecoveryActions";
import { verifyFailedGeminiDocumentCoverage } from "./integrations/geminiFailedDocumentCoverage";

vi.mock("./integrations/geminiFailedDocumentCoverage", () => ({ verifyFailedGeminiDocumentCoverage: vi.fn() }));
const jobId = "job-id" as Id<"integrationJobs">;
const args = { jobId, reason: "Exclude confirmed failed provider document", idempotencyKey: "failed-recovery-fixture" };
const result = { status: "succeeded" as const, jobId, correlationId: "recovery-correlation" };
const failure = { ...result, status: "failed" as const };
const target = { storeName: "fileSearchStores/fixture", operationName: "fileSearchStores/fixture/upload/operations/retained",
  metadata: { environment: "test", jurisdiction_id: "jurisdiction-id", resource_id: "resource-id", version_id: "version-id", version_number: "1", sha256: "a".repeat(64) } };
const claim = { kind: "claimed" as const, operationId: "operation-id" as Id<"adminOperations">,
  leaseToken: "private-lease-token", binding: "b".repeat(64), jurisdictionId: "jurisdiction-id" as Id<"jurisdictions">,
  coverage: { target, published: [], excluded: [] } };
const attempt = { operationId: claim.operationId, leaseToken: claim.leaseToken, binding: claim.binding, jurisdictionId: claim.jurisdictionId };
const proof = { documentReference: `sha256:${"c".repeat(64)}`, operationReference: `sha256:${"d".repeat(64)}`,
  firstObservedAt: 100, confirmedAt: 101, coverageVerifiedAt: 101, publishedCount: 18 };
const claimRef = makeFunctionReference<"mutation">("admin/geminiFailedRecovery:claimFailedDocumentRecovery");
const completeRef = makeFunctionReference<"mutation">("admin/geminiFailedRecovery:completeFailedDocumentRecovery");
const abortRef = makeFunctionReference<"mutation">("admin/geminiFailedRecovery:abortFailedDocumentRecovery");
function context() {
  return { runMutation: vi.fn(async (_ref: unknown, _args: unknown): Promise<unknown> => claim),
    runAction: vi.fn(() => { throw new Error("Unexpected nested action"); }), runQuery: vi.fn(() => { throw new Error("Unexpected query"); }),
    scheduler: { runAfter: vi.fn(() => { throw new Error("Unexpected scheduling"); }) } };
}
const handler = (reconcileFailedDocument as unknown as { _handler: (ctx: ActionCtx, input: typeof args) => Promise<unknown> })._handler;
const invoke = (ctx: ReturnType<typeof context>) => handler(ctx as unknown as ActionCtx, args);
beforeEach(() => { vi.stubEnv("GOOGLE_AI_API_KEY", "server-only-test-key"); vi.mocked(verifyFailedGeminiDocumentCoverage).mockResolvedValue(proof); });
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
describe("internal failed-document recovery action", () => {
  it("passes the exact claim and fresh GET-only proof to guarded completion", async () => {
    expect(reconcileFailedDocument).toHaveProperty("isInternal", true);
    const ctx = context(); ctx.runMutation.mockResolvedValueOnce(claim).mockResolvedValueOnce(result);
    expect(await invoke(ctx)).toEqual(result);
    expect(ctx.runMutation).toHaveBeenNthCalledWith(1, claimRef, args);
    expect(verifyFailedGeminiDocumentCoverage).toHaveBeenCalledExactlyOnceWith(claim.coverage, "server-only-test-key");
    expect(ctx.runMutation).toHaveBeenNthCalledWith(2, completeRef, { ...attempt, ...proof });
    expect(ctx.runMutation).toHaveBeenCalledTimes(2); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled(); expect(ctx.runAction).not.toHaveBeenCalled();
  });
  it.each([result, failure])("replays a completed receipt without another provider read", async saved => {
    const ctx = context(); ctx.runMutation.mockResolvedValueOnce({ kind: "completed", result: saved });
    expect(await invoke(ctx)).toEqual(saved); expect(ctx.runMutation).toHaveBeenCalledExactlyOnceWith(claimRef, args);
    expect(verifyFailedGeminiDocumentCoverage).not.toHaveBeenCalled();
  });
  it("rejects missing backend credentials before claiming", async () => {
    vi.stubEnv("GOOGLE_AI_API_KEY", ""); const ctx = context();
    await expect(invoke(ctx)).rejects.toThrow("GEMINI_FAILED_DOCUMENT_RECOVERY_NOT_CONFIGURED");
    expect(ctx.runMutation).not.toHaveBeenCalled(); expect(verifyFailedGeminiDocumentCoverage).not.toHaveBeenCalled();
  });
  it("denies E2E fixture mode before claiming", async () => {
    vi.stubEnv("ADMIN_E2E_FIXTURE_MODE", "true"); const ctx = context();
    await expect(invoke(ctx)).rejects.toThrow("E2E_PROVIDER_ISOLATION_MISCONFIGURED"); expect(ctx.runMutation).not.toHaveBeenCalled();
  });
  it("does not abort or contact Gemini after an unclaimed authority rejection", async () => {
    const ctx = context(); ctx.runMutation.mockRejectedValueOnce(new Error("RECOVERY_PUBLISHER_UNAUTHORIZED"));
    await expect(invoke(ctx)).rejects.toThrow("RECOVERY_PUBLISHER_UNAUTHORIZED");
    expect(ctx.runMutation).toHaveBeenCalledTimes(1); expect(verifyFailedGeminiDocumentCoverage).not.toHaveBeenCalled();
  });
  it("aborts only the matching claim and never forwards a provider body", async () => {
    const ctx = context(); ctx.runMutation.mockResolvedValueOnce(claim).mockResolvedValueOnce(failure);
    vi.mocked(verifyFailedGeminiDocumentCoverage).mockRejectedValueOnce(new Error("server-only-test-key private body"));
    expect(await invoke(ctx)).toEqual(failure); expect(ctx.runMutation).toHaveBeenNthCalledWith(2, abortRef, attempt);
    expect(JSON.stringify(ctx.runMutation.mock.calls)).not.toContain("private body"); expect(ctx.runMutation).toHaveBeenCalledTimes(2);
  });
  it("aborts after completion detects stale binding without retrying proof", async () => {
    const ctx = context(); ctx.runMutation.mockResolvedValueOnce(claim).mockRejectedValueOnce(new Error("stale snapshot")).mockResolvedValueOnce(failure);
    expect(await invoke(ctx)).toEqual(failure); expect(ctx.runMutation).toHaveBeenNthCalledWith(3, abortRef, attempt);
    expect(verifyFailedGeminiDocumentCoverage).toHaveBeenCalledTimes(1); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("preserves a committed success after response-delivery failure", async () => {
    const ctx = context(); ctx.runMutation.mockResolvedValueOnce(claim).mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(result);
    expect(await invoke(ctx)).toEqual(result); expect(ctx.runMutation).toHaveBeenNthCalledWith(3, abortRef, attempt);
  });
  it("redacts abort failure without retrying or scheduling", async () => {
    const ctx = context(); ctx.runMutation.mockResolvedValueOnce(claim).mockRejectedValueOnce(new Error("private abort body"));
    vi.mocked(verifyFailedGeminiDocumentCoverage).mockRejectedValueOnce(new Error("private provider body"));
    await expect(invoke(ctx)).rejects.toThrow("GEMINI_FAILED_DOCUMENT_RECOVERY_FAILED");
    expect(ctx.runMutation).toHaveBeenCalledTimes(2); expect(verifyFailedGeminiDocumentCoverage).toHaveBeenCalledTimes(1);
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
});
