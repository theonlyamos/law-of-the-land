import { makeFunctionReference } from "convex/server";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectIndexJob } from "./geminiDiagnosticActions";
import { inspectGeminiProvider } from "./integrations/geminiDiagnostic";

vi.mock("./integrations/geminiDiagnostic", async (original) => ({
  ...await original<typeof import("./integrations/geminiDiagnostic")>(),
  inspectGeminiProvider: vi.fn(),
}));

const jobId = "job-id" as Id<"integrationJobs">;
const context = {
  job: { id: jobId, status: "manual_review", correlationId: "job_fixture", providerPollingStartedAt: 1, providerPollCount: 526, updatedAt: 2 },
  target: { operationName: "fileSearchStores/fixture/upload/operations/retained", storeName: "fileSearchStores/fixture",
    metadata: { environment: "production", jurisdiction_id: "jurisdiction", resource_id: "resource", version_id: "version", version_number: "1", sha256: "a".repeat(64) } },
};

function actionContext() {
  return {
    runQuery: vi.fn(async () => context),
    runMutation: vi.fn(() => { throw new Error("Unexpected mutation"); }),
    runAction: vi.fn(() => { throw new Error("Unexpected action"); }),
    scheduler: { runAfter: vi.fn(() => { throw new Error("Unexpected schedule"); }) },
    storage: { getUrl: vi.fn(() => { throw new Error("Unexpected storage access"); }) },
  };
}

// Convex exposes this runtime handler to its test harness, but omits it from the public type.
const handler = (inspectIndexJob as unknown as {
  _handler: (ctx: ActionCtx, args: { jobId: Id<"integrationJobs"> }) => Promise<unknown>;
})._handler;
const invoke = (ctx: ReturnType<typeof actionContext>) => handler(ctx as unknown as ActionCtx, { jobId });

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("internal Gemini diagnostic action", () => {
  it("uses the stored target and server credential without mutating, scheduling, or reading original bytes", async () => {
    expect(inspectIndexJob).toHaveProperty("isInternal", true);
    vi.stubEnv("GOOGLE_AI_API_KEY", "server-only-test-key");
    const provider = { operation: { done: false }, documents: { matches: [] } };
    vi.mocked(inspectGeminiProvider).mockResolvedValue(provider as never);
    const ctx = actionContext();
    const result = await invoke(ctx);
    expect(ctx.runQuery).toHaveBeenCalledExactlyOnceWith(
      makeFunctionReference<"query">("admin/geminiDiagnostics:getIndexDiagnosticTarget"), { jobId });
    expect(inspectGeminiProvider).toHaveBeenCalledExactlyOnceWith(context.target, "server-only-test-key");
    expect(result).toEqual({ observedAt: expect.any(Number), job: context.job, provider });
    expect(JSON.stringify(result)).not.toContain("server-only-test-key");
    expect(JSON.stringify(result)).not.toContain("fileSearchStores/");
    expect(ctx.runMutation).not.toHaveBeenCalled();
    expect(ctx.runAction).not.toHaveBeenCalled();
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    expect(ctx.storage.getUrl).not.toHaveBeenCalled();
  });

  it("blocks live provider requests in isolated E2E mode", async () => {
    vi.stubEnv("ADMIN_E2E_FIXTURE_MODE", "true");
    vi.stubEnv("ADMIN_E2E_TARGET_ENV", "test");
    vi.stubEnv("ADMIN_E2E_ISOLATED_TARGET_MARKER", "isolated-admin-e2e");
    vi.stubEnv("ADMIN_E2E_PROVIDER_STUB_MODE", "true");
    const ctx = actionContext();
    await expect(invoke(ctx)).rejects.toThrow("GEMINI_DIAGNOSTIC_UNAVAILABLE_IN_E2E");
    expect(ctx.runQuery).not.toHaveBeenCalled();
    expect(inspectGeminiProvider).not.toHaveBeenCalled();
  });

  it("fails closed for partial E2E configuration", async () => {
    vi.stubEnv("ADMIN_E2E_FIXTURE_MODE", "true");
    await expect(invoke(actionContext())).rejects.toThrow("E2E_PROVIDER_ISOLATION_MISCONFIGURED");
    expect(inspectGeminiProvider).not.toHaveBeenCalled();
  });

  it("does not call Gemini when target validation fails or the credential is missing", async () => {
    vi.stubEnv("GOOGLE_AI_API_KEY", "server-only-test-key");
    const ctx = actionContext();
    ctx.runQuery.mockRejectedValueOnce(new Error("GEMINI_DIAGNOSTIC_TARGET_INVALID"));
    await expect(invoke(ctx)).rejects.toThrow("GEMINI_DIAGNOSTIC_TARGET_INVALID");
    vi.stubEnv("GOOGLE_AI_API_KEY", "");
    await expect(invoke(actionContext())).rejects.toThrow("GEMINI_DIAGNOSTIC_NOT_CONFIGURED");
    expect(inspectGeminiProvider).not.toHaveBeenCalled();
  });

  it("does not expose an unexpected provider error containing credentials", async () => {
    vi.stubEnv("GOOGLE_AI_API_KEY", "server-only-test-key");
    vi.mocked(inspectGeminiProvider).mockRejectedValue(new Error("server-only-test-key private response"));
    await expect(invoke(actionContext())).rejects.toThrow("GEMINI_DIAGNOSTIC_READ_FAILED");
  });
});
