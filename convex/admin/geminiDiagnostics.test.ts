/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../schema";
import { getIndexDiagnosticTarget } from "./geminiDiagnostics";

const modules = Object.fromEntries(Object.entries(import.meta.glob("../**/*.ts"))
  .map(([path, load]) => [path.startsWith("../") ? `./${path.slice(3)}` : `./admin/${path.slice(2)}`, load]));
const targetRef = makeFunctionReference<"query">("admin/geminiDiagnostics:getIndexDiagnosticTarget");

async function fixture() {
  const t = convexTest(schema, modules);
  vi.stubEnv("ADMIN_ENVIRONMENT", "production");
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const jurisdictionId = await ctx.db.insert("jurisdictions", {
      name: "OHADA fixture", slug: "diagnostic-ohada", status: "enabled", isDefault: false,
      geminiFileSearchStoreName: "fileSearchStores/diagnostic-ohada",
      providerSyncState: "drifted", createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
    });
    const resourceId = await ctx.db.insert("legalResources", {
      jurisdictionId, type: "act", title: "Insolvency fixture", issuer: "fixture",
      officialCitation: "fixture", officialCitationKey: "fixture", sourceUrl: "https://example.invalid",
      topics: [], status: "active", createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
    });
    const originalStorageId = await ctx.storage.store(new Blob(["law"]));
    const versionId = await ctx.db.insert("documentVersions", {
      resourceId, versionNumber: 1, originalStorageId, filename: "law.pdf", mimeType: "application/pdf",
      byteSize: 3, sha256: "a".repeat(64), sourceUrl: "https://example.invalid", status: "publishing",
      failureSummary: "Old timeout", submittedBy: "fixture", createdAt: now, updatedAt: now,
    });
    const jobId = await ctx.db.insert("integrationJobs", {
      type: "gemini_index_document", targetType: "documentVersion", targetId: versionId,
      payload: JSON.stringify({ operation: "publish", storeName: "fileSearchStores/diagnostic-ohada", sha256: "a".repeat(64) }),
      actorId: "former-actor", actorRoles: ["super_admin"], idempotencyKey: "fixture", requestFingerprint: "fixture",
      correlationId: "job_fixture", providerOperationName: "fileSearchStores/diagnostic-ohada/upload/operations/retained",
      providerPollingStartedAt: now - 7 * 60 * 60_000, providerPollCount: 527, recoveryKind: "poll_operation",
      status: "manual_review", attemptCount: 0, lastErrorKind: "timeout", createdAt: now, updatedAt: now,
    });
    const lockId = await ctx.db.insert("documentLifecycleLocks", {
      resourceId, versionId, operation: "publish", actorId: "former-actor", idempotencyKey: "fixture",
      jobId, expiresAt: now - 60_000, createdAt: now, updatedAt: now,
    });
    return { jurisdictionId, resourceId, versionId, jobId, lockId };
  });
  return { t, ...ids };
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Gemini diagnostic target binding", () => {
  it("runs the registered action through its query and return validator without changing stored state", async () => {
    const { t, jobId, versionId, resourceId, jurisdictionId, lockId } = await fixture();
    vi.stubEnv("GOOGLE_AI_API_KEY", "server-only-fixture-key");
    const snapshot = () => t.run(async (ctx) => Promise.all([jobId, versionId, resourceId, jurisdictionId, lockId].map(id => ctx.db.get(id))));
    const before = await snapshot();
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      methods.push(init?.method ?? (input instanceof Request ? input.method : "GET"));
      const body = url.includes("/upload/operations/")
        ? { name: "fileSearchStores/diagnostic-ohada/upload/operations/retained", done: false }
        : { documents: [] };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }));
    const result = await t.action(makeFunctionReference<"action">("admin/geminiDiagnosticActions:inspectIndexJob"), { jobId });
    expect(result).toMatchObject({ job: { id: jobId, status: "manual_review" }, provider: {
      operation: { status: "ok", done: false }, documents: { scanComplete: true, matchingCount: 0 },
    } });
    expect(methods).toEqual(["GET", "GET"]);
    expect(await snapshot()).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("server-only-fixture-key");
  });

  it("is internal-only and reads a timed-out job even after its lifecycle lease expires", async () => {
    expect(getIndexDiagnosticTarget).toHaveProperty("isInternal", true);
    const { t, jobId, versionId, resourceId, jurisdictionId, lockId } = await fixture();
    const snapshot = () => t.run(async (ctx) => Promise.all([jobId, versionId, resourceId, jurisdictionId, lockId].map(id => ctx.db.get(id))));
    const before = await snapshot();
    const result = await t.query(targetRef, { jobId });
    expect(result).toMatchObject({
      job: { id: jobId, status: "manual_review", correlationId: "job_fixture", providerPollCount: 527 },
      target: {
        storeName: "fileSearchStores/diagnostic-ohada",
        operationName: "fileSearchStores/diagnostic-ohada/upload/operations/retained",
        metadata: { environment: "production", jurisdiction_id: jurisdictionId, resource_id: resourceId,
          version_id: versionId, version_number: "1", sha256: "a".repeat(64) },
      },
    });
    expect(await snapshot()).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("originalStorageId");
    expect(JSON.stringify(result)).not.toContain("leaseToken");
    expect(JSON.stringify(result)).not.toContain("Old timeout");
  });

  it.each(["wrong_type", "wrong_target", "missing_operation", "cross_store_operation", "cross_store_payload", "wrong_sha", "invalid_payload", "wrong_recovery"])("rejects %s before any provider access", async (scenario) => {
    const { t, jobId, resourceId } = await fixture();
    await t.run(async (ctx) => {
      if (scenario === "wrong_type") await ctx.db.patch(jobId, { type: "gemini_delete_document" });
      if (scenario === "wrong_target") await ctx.db.patch(jobId, { targetId: resourceId });
      if (scenario === "missing_operation") await ctx.db.patch(jobId, { providerOperationName: undefined });
      if (scenario === "cross_store_operation") await ctx.db.patch(jobId, { providerOperationName: "fileSearchStores/other/upload/operations/retained" });
      if (scenario === "cross_store_payload") await ctx.db.patch(jobId, { payload: JSON.stringify({ operation: "publish", storeName: "fileSearchStores/other", sha256: "a".repeat(64) }) });
      if (scenario === "wrong_sha") await ctx.db.patch(jobId, { payload: JSON.stringify({ operation: "publish", storeName: "fileSearchStores/diagnostic-ohada", sha256: "b".repeat(64) }) });
      if (scenario === "invalid_payload") await ctx.db.patch(jobId, { payload: "[]" });
      if (scenario === "wrong_recovery") await ctx.db.patch(jobId, { recoveryKind: "delete_document" });
    });
    await expect(t.query(targetRef, { jobId })).rejects.toThrow("GEMINI_DIAGNOSTIC_TARGET_INVALID");
  });

  it("rejects ambiguous store ownership", async () => {
    const { t, jobId, jurisdictionId } = await fixture();
    await t.run(async (ctx) => {
      const original = (await ctx.db.get(jurisdictionId))!;
      const { _id, _creationTime, ...fields } = original;
      void _id; void _creationTime;
      await ctx.db.insert("jurisdictions", { ...fields, slug: "duplicate-owner" });
    });
    await expect(t.query(targetRef, { jobId })).rejects.toThrow("GEMINI_DIAGNOSTIC_TARGET_INVALID");
  });

  it("rejects a job bound to another organization", async () => {
    const { t, jobId } = await fixture();
    await t.run(async (ctx) => {
      const now = Date.now();
      const organizationId = await ctx.db.insert("organizations", {
        name: "Other", slug: "other", class: "company", status: "active",
        createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
      });
      await ctx.db.patch(jobId, { organizationId });
    });
    await expect(t.query(targetRef, { jobId })).rejects.toThrow("GEMINI_DIAGNOSTIC_TARGET_INVALID");
  });

  it("rejects a missing environment and caller-supplied provider targets", async () => {
    const { t, jobId } = await fixture();
    vi.stubEnv("ADMIN_ENVIRONMENT", "");
    await expect(t.query(targetRef, { jobId })).rejects.toThrow("GEMINI_DIAGNOSTIC_ENVIRONMENT_INVALID");
    await expect(t.query(targetRef, { jobId, operationName: "arbitrary" })).rejects.toThrow();
  });
});
