/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import authSchema from "./betterAuth/schema";
import polarSchema from "../node_modules/@convex-dev/polar/src/component/schema";
import schema from "./schema";
import { resolveChatResearchStoresForJurisdiction } from "./jurisdictions";
import * as jobContracts from "../shared/reviewed-employment-jobs";
import { createOpaqueTelemetryToken, createTelemetryServiceProof } from "./lib/telemetryProof";
import { completeGovernedInteractionProofParts } from "./chats";
import type { ReviewedEmploymentCommitInput } from "./reviewedEmploymentCompletion";

const policy = vi.hoisted(() => ({ jurisdictionId: "", resourceId: "", versionId: "", expectedSha256: "", expectedByteSize: 0 }));
vi.mock("../shared/reviewed-employment-policy", async importOriginal => {
  const actual = await importOriginal<typeof import("../shared/reviewed-employment-policy")>();
  return { ...actual, REVIEWED_EMPLOYMENT_POLICY: policy,
    reviewedEmploymentBackendPolicy: (env: Parameters<typeof actual.reviewedEmploymentBackendPolicy>[0]) =>
      actual.reviewedEmploymentBackendPolicy(env) ? policy : null };
});
const modules = import.meta.glob("./**/*.ts");
const authModules = Object.fromEntries(Object.entries(import.meta.glob("./betterAuth/**/*.ts"))
  .map(([path, load]) => [`./${path.slice("./betterAuth/".length)}`, load]));
const polarModules = Object.fromEntries(Object.entries(import.meta.glob("../node_modules/@convex-dev/polar/src/component/**/*.ts"))
  .map(([path, load]) => [`./${path.slice("../node_modules/@convex-dev/polar/src/component/".length)}`, load]));
const submitRef = makeFunctionReference<"mutation">("reviewedEmploymentJobs:submit");
const workerRef = makeFunctionReference<"mutation">("reviewedEmploymentJobs:worker");
const getRef = makeFunctionReference<"query">("reviewedEmploymentJobs:getForChat");
const cancelRef = makeFunctionReference<"mutation">("reviewedEmploymentJobs:cancel");
const candidateSha256 = "b".repeat(64), requestSha256 = "c".repeat(64);
const section55Request = { sourceId: "local-act651-experimental",
  versionId: "sha256-125e8ce4d70beb6fbe6adc5f9cbaec27dc435c484a62b3eee38bf80cff466f5a",
  pdfOrdinal: 18, reviewedSpanId: "p18-s55-1-2" };
function productionEnvironment(admission = true, execution = true) {
  vi.stubEnv("CONVEX_CLOUD_URL", "https://loyal-koala-720.eu-west-1.convex.cloud");
  vi.stubEnv("CONVEX_SITE_URL", "https://loyal-koala-720.eu-west-1.convex.site");
  vi.stubEnv("REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED", admission ? "1" : undefined);
  vi.stubEnv("REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED", execution ? "1" : undefined);
}
async function fixture() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  t.registerComponent("polar", polarSchema, polarModules);
  const ids = await t.run(async ctx => {
    const now = Date.now();
    const account = async (name: string) => {
      const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: {
        name, email: `${name}@example.com`, emailVerified: true, createdAt: now, updatedAt: now,
        role: "user", banned: false, twoFactorEnabled: false,
      } } });
      const authSession = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "session", data: {
        token: crypto.randomUUID(), userId: user._id, expiresAt: now + 86_400_000, createdAt: now, updatedAt: now,
      } } });
      return { subject: user._id, sessionId: authSession._id };
    };
    const identity = await account("background-owner"), otherIdentity = await account("background-other");
    await ctx.db.insert("featureFlags", { key: "unified_jurisdictions", environment: "test", enabled: true, updatedAt: now });
    const storeName = "fileSearchStores/background-fixture";
    const jurisdictionId = await ctx.db.insert("jurisdictions", { name: "Synthetic employment jurisdiction", slug: "background-fixture",
      status: "enabled", kind: "geographic", visibility: "public", isDefault: false, providerSyncState: "synced",
      geminiFileSearchStoreName: storeName, createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now });
    await ctx.db.insert("geographicJurisdictions", { jurisdictionId, googlePlaceId: "background-place", level: "country",
      latitude: 0, longitude: 0, formattedAddress: "Synthetic employment jurisdiction", createdAt: now, updatedAt: now });
    const bytes = new TextEncoder().encode("Synthetic reviewed employment edition.");
    const expectedSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const originalStorageId = await ctx.storage.store(new Blob([bytes], { type: "application/pdf" }));
    const resourceId = await ctx.db.insert("legalResources", { jurisdictionId, type: "act", title: "Synthetic Employment Act",
      issuer: "Fixture", officialCitation: "Fixture Act", officialCitationKey: "fixture act", sourceUrl: "https://example.com/fixture",
      topics: ["employment"], effectiveDate: "2003-10-08", status: "active", catalogPublished: true,
      createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now });
    const versionId = await ctx.db.insert("documentVersions", { resourceId, versionNumber: 1, originalStorageId,
      filename: "fixture.pdf", mimeType: "application/pdf", byteSize: bytes.byteLength, sha256: expectedSha256,
      sourceUrl: "https://example.com/fixture", status: "published", geminiDocumentName: `${storeName}/documents/fixture`,
      submittedBy: "fixture", publishedAt: now, createdAt: now, updatedAt: now });
    await ctx.db.patch(resourceId, { activeVersionId: versionId });
    return { identity, otherIdentity, jurisdictionId, resourceId, versionId, storeName, originalStorageId,
      expectedSha256, expectedByteSize: bytes.byteLength };
  });
  Object.assign(policy, { jurisdictionId: ids.jurisdictionId, resourceId: ids.resourceId, versionId: ids.versionId,
    expectedSha256: ids.expectedSha256, expectedByteSize: ids.expectedByteSize });
  const owner = t.withIdentity(ids.identity), other = t.withIdentity(ids.otherIdentity), externalId = "background-chat";
  await owner.mutation(api.chats.ensure, { externalId, jurisdictionId: ids.jurisdictionId });
  const payload = { query: "Do I need written consent?", messages: [], historyComplete: true,
    selection: { status: "selected", question: "Do I need written consent?", facts: "private facts",
      requests: [section55Request], topics: ["overtime"], evidence: {} },
    facts: "private facts", attachmentIds: [], contextAttachmentIds: [], routeNonce: createOpaqueTelemetryToken() };
  const args = { submissionId: "answer-1", externalId, jurisdictionId: ids.jurisdictionId,
    userClientId: "question-1", assistantClientId: "answer-1", submission: JSON.stringify(payload) };
  const signed = async (patch = {}) => {
    const input = { ...args, ...patch, issuedAt: Date.now() };
    return { ...input, serviceProof: await createTelemetryServiceProof(["reviewed-employment-background-submit-v1",
      input.submissionId, input.externalId, input.jurisdictionId, input.userClientId, input.assistantClientId, input.submission, input.issuedAt]) };
  };
  const submit = async (patch = {}) => owner.mutation(submitRef, await signed(patch));
  const worker = async (jobId: string, operation: string, value: unknown = {}, workerId = "worker-1", issuedAt = Date.now()) => {
    const body = JSON.stringify(value);
    return t.mutation(workerRef, { jobId, workerId, operation, body, issuedAt,
      serviceProof: await createTelemetryServiceProof(["reviewed-employment-background-worker-v1", jobId, workerId, operation, body, issuedAt]) });
  };
  const source = await owner.query(makeFunctionReference<"query">("reviewedEmployment:authorizeSource"), { externalId,
    ...policy, asOfDate: new Date().toISOString().slice(0, 10) });
  const manifest = await t.run(ctx => resolveChatResearchStoresForJurisdiction(ctx, ids.jurisdictionId));
  const sourceBinding = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(jobContracts.reviewedEmploymentSourceBundleCanonicalJson({ source, manifest })))))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { t, ids, owner, other, args, payload, submit, signed, worker, sourceBinding };
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CONVEX_CLOUD_URL", undefined);
  vi.stubEnv("CONVEX_SITE_URL", undefined);
  vi.stubEnv("ADMIN_ENVIRONMENT", "test");
  vi.stubEnv("TELEMETRY_INGEST_SECRET", "background-fixture-secret-at-least-32-characters");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe("persisted reviewed employment jobs", () => {
  it("binds worker capability into its proof and rejects legacy claims after a store becomes restricted", async () => {
    const f = await fixture(), job = await f.submit();
    await f.t.run(async ctx => {
      const { _id: _id, _creationTime: _creationTime, ...version } = (await ctx.db.get(f.ids.versionId))!;
      const failedId = await ctx.db.insert("documentVersions", { ...version, versionNumber: 2, status: "failed", geminiDocumentName: undefined });
      await ctx.db.patch(f.ids.jurisdictionId, { geminiSearchRestriction: { kind: "published_only", establishedAt: Date.now(), failedVersionIds: [failedId] } });
    });
    expect(await f.worker(job.jobId, "claim")).toEqual({ status: "ignored", payload: null });
    const legacy = { jobId: job.jobId, workerId: "capable-worker", operation: "claim" as const, body: "{}", issuedAt: Date.now() };
    const forged = { ...legacy, publicationFilterProtocol: "published-v1" as const,
      serviceProof: await createTelemetryServiceProof(await jobContracts.reviewedEmploymentJobProofParts(legacy)) };
    expect(await f.t.mutation(workerRef, forged)).toEqual({ status: "ignored", payload: null });
    const capable = { ...legacy, publicationFilterProtocol: "published-v1" as const };
    expect((await f.t.mutation(workerRef, { ...capable,
      serviceProof: await createTelemetryServiceProof(await jobContracts.reviewedEmploymentJobProofParts(capable)) })).status).toBe("ok");
    const authority = { ...capable, operation: "authority" as const };
    const reply = await f.t.mutation(workerRef, { ...authority,
      serviceProof: await createTelemetryServiceProof(await jobContracts.reviewedEmploymentJobProofParts(authority)) });
    expect(JSON.parse(reply.payload).manifest.stores[0].publicationFilter.documents).toEqual([
      { resourceId: f.ids.resourceId, versionId: f.ids.versionId, sha256: f.ids.expectedSha256 },
    ]);
    await expect(f.submit({ submissionId: "legacy-answer-2", assistantClientId: "legacy-answer-2", userClientId: "legacy-question-2" }))
      .rejects.toThrow("REVIEWED_EMPLOYMENT_JOB_ACTIVE");
  });
  it("defaults production admission off before storing a job or charging quota", async () => {
    productionEnvironment(false, false);
    const f = await fixture();
    await expect(f.submit()).rejects.toThrow("REVIEWED_EMPLOYMENT_JOB_ADMISSION_UNAVAILABLE");
    expect(await f.t.run(ctx => ctx.db.query("reviewedEmploymentJobs").take(3))).toEqual([]);
    expect(await f.t.run(ctx => ctx.db.query("dailyUsage").take(3))).toEqual([]);
  });
  it("binds new production jobs and worker claims to the immutable deployment policy", async () => {
    productionEnvironment();
    const f = await fixture(), job = await f.submit();
    expect(await f.t.run(ctx => ctx.db.get(job.jobId))).toMatchObject({ policyId: "act651-s55-prod-v1" });
    expect(JSON.parse((await f.worker(job.jobId, "claim")).payload)).toMatchObject({ policyId: "act651-s55-prod-v1" });
  });
  it.each([
    { topics: ["notice"], requests: [{ ...section55Request, pdfOrdinal: 11, reviewedSpanId: "p11-s17" }] },
    { topics: ["overtime", "dismissal"], requests: [section55Request] },
    { topics: ["overtime"], requests: [{ ...section55Request, sourceId: "another-source" }] },
    { topics: ["overtime"], requests: [{ ...section55Request, versionId: "another-version" }] },
    { topics: ["overtime"], requests: [{ ...section55Request, reviewedSpanId: "p18-s56-1" }] },
    { topics: ["overtime"], requests: [{ ...section55Request, injected: true }] },
    { topics: ["overtime"], requests: [section55Request, section55Request] },
  ])("rejects a proof-bound production selection outside the exact section 55 slice: %j", async selection => {
    productionEnvironment();
    const f = await fixture();
    await expect(f.submit({ submission: JSON.stringify({ ...f.payload,
      selection: { ...f.payload.selection, ...selection } }) })).rejects.toThrow("REVIEWED_EMPLOYMENT_JOB_INVALID");
    expect(await f.t.run(ctx => ctx.db.query("reviewedEmploymentJobs").take(3))).toEqual([]);
    expect(await f.t.run(ctx => ctx.db.query("dailyUsage").take(3))).toEqual([]);
  });
  it("keeps owner read and cancel available while both production controls are off", async () => {
    productionEnvironment();
    const f = await fixture(), job = await f.submit();
    expect((await f.worker(job.jobId, "claim")).status).toBe("ok");
    productionEnvironment(false, false);
    expect(await f.owner.query(getRef, { externalId: f.args.externalId, jobId: job.jobId })).toMatchObject({ status: "running" });
    for (const operation of ["state", "authority", "reserve", "passed", "commit"])
      expect(await f.worker(job.jobId, operation, {})).toEqual({ status: "ignored", payload: null });
    expect(await f.owner.mutation(cancelRef, { jobId: job.jobId })).toMatchObject({ status: "cancelled" });
    expect(await f.t.run(ctx => ctx.db.query("messages").take(3))).toEqual([]);
  });
  it("can stop admission while a previously admitted worker completes its reserved stages", async () => {
    productionEnvironment();
    const f = await fixture(), job = await f.submit();
    expect((await f.worker(job.jobId, "claim")).status).toBe("ok");
    productionEnvironment(false, true);
    await expect(f.submit({ submissionId: "answer-2", assistantClientId: "answer-2", userClientId: "question-2" }))
      .rejects.toThrow("REVIEWED_EMPLOYMENT_JOB_ADMISSION_UNAVAILABLE");
    expect((await f.worker(job.jobId, "state")).status).toBe("ok");
    expect((await f.worker(job.jobId, "reserve", { stage: "draft", requestSha256, candidateSha256: null, sourceBinding: f.sourceBinding })).status).toBe("ok");
  });
  it("execution rollback prevents claim or another dispatch and retains uncertain stage reservations", async () => {
    productionEnvironment();
    const f = await fixture(), job = await f.submit();
    productionEnvironment(true, false);
    expect(await f.worker(job.jobId, "claim")).toEqual({ status: "ignored", payload: null });
    productionEnvironment();
    expect((await f.worker(job.jobId, "claim")).status).toBe("ok");
    const reservation = { stage: "draft", requestSha256, candidateSha256: null, sourceBinding: f.sourceBinding };
    expect((await f.worker(job.jobId, "reserve", reservation)).status).toBe("ok");
    productionEnvironment(false, false);
    expect(await f.worker(job.jobId, "passed", { ...reservation, candidateSha256 })).toEqual({ status: "ignored", payload: null });
    productionEnvironment();
    expect(await f.worker(job.jobId, "claim", {}, "replacement-worker")).toEqual({ status: "ignored", payload: null });
    expect(await f.worker(job.jobId, "reserve", reservation)).toEqual({ status: "ignored", payload: null });
    expect(await f.t.run(ctx => ctx.db.query("reviewedEmploymentJobStages").take(5))).toHaveLength(1);
  });
  it("fails closed for a missing or different persisted policy on production jobs", async () => {
    productionEnvironment();
    const f = await fixture(), job = await f.submit();
    for (const policyId of [undefined, "act651-s55-dev-v1"] as const) {
      await f.t.run(ctx => ctx.db.patch(job.jobId, { policyId }));
      expect(await f.worker(job.jobId, "claim")).toEqual({ status: "ignored", payload: null });
    }
    expect(await f.owner.query(getRef, { externalId: f.args.externalId, jobId: job.jobId })).toMatchObject({ status: "queued" });
    expect(await f.owner.mutation(cancelRef, { jobId: job.jobId })).toMatchObject({ status: "cancelled" });
  });
  it("retains compatibility for a legacy DEV job without a policy marker", async () => {
    const f = await fixture(), job = await f.submit();
    await f.t.run(ctx => ctx.db.patch(job.jobId, { policyId: undefined }));
    expect((await f.worker(job.jobId, "claim")).status).toBe("ok");
  });
  it("expires a lost host after one reserved stage without takeover, retry, or late writes even during rollback", async () => {
    productionEnvironment();
    const f = await fixture(), job = await f.submit();
    expect((await f.worker(job.jobId, "claim")).status).toBe("ok");
    const reservation = { stage: "draft", requestSha256, candidateSha256: null, sourceBinding: f.sourceBinding };
    expect((await f.worker(job.jobId, "reserve", reservation)).status).toBe("ok");
    expect(await f.worker(job.jobId, "claim", {}, "replacement-worker")).toEqual({ status: "ignored", payload: null });
    productionEnvironment(false, false);
    vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(270_000);
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await f.owner.query(getRef, { externalId: f.args.externalId })).toMatchObject({ status: "expired", errorReason: "deadline_exceeded" });
    productionEnvironment();
    for (const operation of ["claim", "passed", "commit"])
      expect(await f.worker(job.jobId, operation, {})).toEqual({ status: "ignored", payload: null });
    expect(await f.t.run(ctx => ctx.db.query("messages").take(3))).toEqual([]);
    expect(await f.t.run(ctx => ctx.db.query("reviewedEmploymentJobStages").take(5))).toHaveLength(1);
  });
  it("creates one owner-bound job with fixed deadlines and counts the submission exactly once", async () => {
    const f = await fixture(), startedAt = Date.now(), job = await f.submit();
    expect(job).toMatchObject({ externalId: f.args.externalId, question: f.payload.query, status: "queued", progress: "queued" });
    expect(job.verificationDeadlineAt - job.createdAt).toBe(240_000);
    expect(job.terminalDeadlineAt - job.createdAt).toBe(270_000);
    expect(job.createdAt).toBeGreaterThanOrEqual(startedAt);
    const duplicate = await f.submit({ submission: JSON.stringify({ ...f.payload, routeNonce: createOpaqueTelemetryToken() }) });
    expect(duplicate).toEqual(job);
    expect(await f.t.run(ctx => ctx.db.query("dailyUsage").take(3))).toMatchObject([{ count: 1 }]);
  });
  it("blocks a different active submission and rejects changed content for the same submission ID", async () => {
    const f = await fixture(); await f.submit();
    await expect(f.submit({ submissionId: "answer-2", assistantClientId: "answer-2", userClientId: "question-2" })).rejects.toThrow("REVIEWED_EMPLOYMENT_JOB_ACTIVE");
    await expect(f.submit({ submission: JSON.stringify({ ...f.payload, query: "changed", selection: { ...f.payload.selection, question: "changed" } }) })).rejects.toThrow("REVIEWED_EMPLOYMENT_JOB_CONFLICT");
    expect(await f.t.run(ctx => ctx.db.query("dailyUsage").take(3))).toMatchObject([{ count: 1 }]);
  });
  it("requires both current user authentication and a fresh submit service proof", async () => {
    const f = await fixture(), signed = await f.signed();
    await expect(f.t.mutation(submitRef, signed)).rejects.toThrow();
    await expect(f.other.mutation(submitRef, signed)).rejects.toThrow();
    await expect(f.owner.mutation(submitRef, { ...signed, serviceProof: createOpaqueTelemetryToken() })).rejects.toThrow();
    await expect(f.owner.mutation(submitRef, { ...signed, submission: signed.submission + " " })).rejects.toThrow();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 60_001);
    await expect(f.owner.mutation(submitRef, signed)).rejects.toThrow();
  });
  it("projects reload progress only to the owner without private payload or worker authority", async () => {
    const f = await fixture(), job = await f.submit(), sourceBinding = f.sourceBinding;
    expect(await f.owner.query(getRef, { externalId: f.args.externalId })).toEqual(job);
    expect(await f.other.query(getRef, { externalId: f.args.externalId })).toBeNull();
    expect(await f.t.query(getRef, { externalId: f.args.externalId })).toBeNull();
    const serialized = JSON.stringify(job);
    for (const value of ["private facts", "selection", "routeNonce", "sourceBinding", "nativeAuthSessionId", "workerId", "candidateSha256"]) expect(serialized).not.toContain(value);
  });
  it("claims once and ignores duplicate delivery or a different worker", async () => {
    const f = await fixture(), job = await f.submit(), sourceBinding = f.sourceBinding;
    const claim = await f.worker(job.jobId, "claim");
    expect(claim.status).toBe("ok");
    expect(JSON.parse(claim.payload)).toMatchObject({ submission: f.args.submission, verificationDeadlineAt: job.verificationDeadlineAt });
    expect(await f.worker(job.jobId, "claim")).toEqual({ status: "ignored", payload: null });
    expect(await f.worker(job.jobId, "claim", {}, "worker-2")).toEqual({ status: "ignored", payload: null });
    expect(await f.worker(job.jobId, "state", {}, "worker-2")).toEqual({ status: "ignored", payload: null });
  });
  it("rejects worker proofs that are stale or altered across operation, job, worker or body", async () => {
    const f = await fixture(), job = await f.submit(), sourceBinding = f.sourceBinding;
    expect(await f.worker(job.jobId, "claim", {}, "worker-1", Date.now() - 60_001)).toEqual({ status: "ignored", payload: null });
    const input = { jobId: job.jobId, workerId: "worker-1", operation: "claim", body: "{}", issuedAt: Date.now() };
    const serviceProof = await createTelemetryServiceProof(["reviewed-employment-background-worker-v1", input.jobId, input.workerId, input.operation, input.body, input.issuedAt]);
    for (const patch of [{ operation: "authority" }, { workerId: "other" }, { body: "{\"changed\":true}" }]) {
      expect(await f.t.mutation(workerRef, { ...input, serviceProof, ...patch })).toEqual({ status: "ignored", payload: null });
    }
  });
  it("persists ordered stage reservations once and accepts only their exact matching pass", async () => {
    const f = await fixture(), job = await f.submit(), sourceBinding = f.sourceBinding; expect((await f.worker(job.jobId, "claim")).status).toBe("ok");
    const draft = { stage: "draft", requestSha256, candidateSha256: null, sourceBinding };
    expect((await f.worker(job.jobId, "passed", { ...draft, candidateSha256 })).status).toBe("ignored");
    expect((await f.worker(job.jobId, "reserve", { ...draft, stage: "consent" })).status).toBe("ignored");
    expect((await f.worker(job.jobId, "reserve", draft)).status).toBe("ok");
    expect((await f.worker(job.jobId, "reserve", draft)).status).toBe("ignored");
    expect((await f.worker(job.jobId, "passed", { ...draft, requestSha256: "d".repeat(64), candidateSha256 })).status).toBe("ignored");
    expect((await f.worker(job.jobId, "passed", { ...draft, candidateSha256 })).status).toBe("ok");
    for (const stage of ["inventory", "consent", "overtime"]) {
      const reservation = { stage, requestSha256, candidateSha256, sourceBinding };
      expect((await f.worker(job.jobId, "reserve", { ...reservation, candidateSha256: "d".repeat(64) })).status).toBe("ignored");
      expect((await f.worker(job.jobId, "reserve", reservation)).status).toBe("ok");
      expect((await f.worker(job.jobId, "passed", reservation)).status).toBe("ok");
    }
    expect(await f.owner.query(getRef, { externalId: f.args.externalId })).toMatchObject({ status: "running", progress: "commit" });
    expect(await f.t.run(ctx => ctx.db.query("reviewedEmploymentJobStages").take(10))).toHaveLength(4);
  });
  it("cancellation makes late reservations, passes and commits inert", async () => {
    const f = await fixture(), job = await f.submit(), sourceBinding = f.sourceBinding; expect((await f.worker(job.jobId, "claim")).status).toBe("ok");
    await expect(f.other.mutation(cancelRef, { jobId: job.jobId })).resolves.toBeNull();
    expect(await f.owner.mutation(cancelRef, { jobId: job.jobId })).toMatchObject({ status: "cancelled", errorReason: "cancelled" });
    for (const operation of ["reserve", "passed", "commit"]) expect(await f.worker(job.jobId, operation, {})).toEqual({ status: "ignored", payload: null });
    expect(await f.t.run(ctx => ctx.db.query("messages").take(3))).toEqual([]);
  });
  it("uses the created clock after reload and prevents new provider stages after verification expiry", async () => {
    const f = await fixture(), job = await f.submit(), sourceBinding = f.sourceBinding; expect((await f.worker(job.jobId, "claim")).status).toBe("ok");
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(job.verificationDeadlineAt);
    expect(await f.owner.query(getRef, { externalId: f.args.externalId })).toMatchObject({ createdAt: job.createdAt, verificationDeadlineAt: job.verificationDeadlineAt });
    expect((await f.worker(job.jobId, "reserve", { stage: "draft", requestSha256, candidateSha256: null, sourceBinding })).status).toBe("ignored");
    vi.setSystemTime(job.terminalDeadlineAt);
    expect(await f.worker(job.jobId, "commit", {})).toEqual({ status: "ignored", payload: null });
    expect(await f.owner.query(getRef, { externalId: f.args.externalId })).toMatchObject({ status: "expired", errorReason: "deadline_exceeded" });
  });
  it("expires an abandoned job through its scheduled callback", async () => {
    const f = await fixture(), job = await f.submit(), sourceBinding = f.sourceBinding;
    vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(270_000);
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await f.owner.query(getRef, { externalId: f.args.externalId })).toMatchObject({ status: "expired" });
  });
  it("fresh worker authority fails closed after catalog or owner native session revocation", async () => {
    const f = await fixture(), job = await f.submit(), sourceBinding = f.sourceBinding; expect((await f.worker(job.jobId, "claim")).status).toBe("ok");
    expect((await f.worker(job.jobId, "authority")).status).toBe("ok");
    await f.t.run(ctx => ctx.db.patch(f.ids.resourceId, { catalogPublished: false }));
    expect((await f.worker(job.jobId, "authority")).status).toBe("ignored");
  });
  it.each(["DEV", "production"] as const)("keeps an earlier background pair before a later tab turn and preserves the latest preview on %s", async environment => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const submittedAt = Date.UTC(2026, 9, 8, 12);
    vi.setSystemTime(submittedAt);
    if (environment === "production") productionEnvironment();
    const f = await fixture(), job = await f.submit(), sourceBinding = f.sourceBinding;
    expect(job.createdAt).toBe(submittedAt);
    expect((await f.worker(job.jobId, "claim")).status).toBe("ok");
    const answer = "This reviewed edition requires written consent before the arrangement.";
    const answerSha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(answer))))
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const input: ReviewedEmploymentCommitInput = {
      completion: { routeNonce: f.payload.routeNonce, externalId: f.args.externalId, jurisdictionId: f.ids.jurisdictionId,
        assistantClientId: f.args.assistantClientId, finalAnswer: answer, answerKind: "legal", outcome: "success",
        citations: [{ jurisdictionId: f.ids.jurisdictionId, resourceId: f.ids.resourceId, versionId: f.ids.versionId,
          providerStoreName: f.ids.storeName, pageNumber: environment === "production" ? 18 : 11 }],
        model: "reviewed-background-fixture", elapsedMs: 1000, authorizedScopeSize: 1, readyStoreCount: 1, partialCoverage: false,
        jurisdictionCoverage: [{ ordinal: 0, relation: "selected", coverage: "evidence" }], attachmentIds: [] },
      source: { jurisdictionId: f.ids.jurisdictionId, resourceId: f.ids.resourceId, versionId: f.ids.versionId,
        expectedSha256: f.ids.expectedSha256, expectedByteSize: f.ids.expectedByteSize, asOfDate: new Date().toISOString().slice(0, 10) },
      user: { clientId: f.args.userClientId, content: f.payload.query, attachmentIds: [] },
    };
    for (const stage of ["draft", "inventory", "consent", "overtime"]) {
      const reservation = { stage, requestSha256, candidateSha256: stage === "draft" ? null : answerSha, sourceBinding };
      expect((await f.worker(job.jobId, "reserve", reservation)).status).toBe("ok");
      expect((await f.worker(job.jobId, "passed", { ...reservation, candidateSha256: answerSha })).status).toBe("ok");
    }
    // A second authenticated tab saves a complete ordinary turn while the
    // earlier background request is still running. Neither append supplies time.
    const laterTab = f.t.withIdentity(f.ids.identity), laterAt = submittedAt + 30_000;
    vi.setSystemTime(laterAt);
    const laterQuestion = "What should I ask my manager next?", laterAnswer = "Ask the manager to confirm the later arrangement in writing.";
    const laterCompletion = { ...input.completion, routeNonce: createOpaqueTelemetryToken(),
      assistantClientId: "later-answer", finalAnswer: laterAnswer };
    const laterResult = await laterTab.mutation(api.chats.completeGovernedInteraction, { ...laterCompletion,
      serviceProof: await createTelemetryServiceProof(await completeGovernedInteractionProofParts(laterCompletion)) });
    if (laterResult.status !== "completed" || laterResult.outcome !== "success") throw new Error("Later ordinary turn did not complete");
    await laterTab.mutation(api.chats.appendMessages, { externalId: f.args.externalId, jurisdictionId: f.ids.jurisdictionId,
      lastMessage: laterAnswer, messages: [
        { role: "user", clientId: "later-question", content: laterQuestion },
        { role: "assistant", clientId: "later-answer", content: laterAnswer, answerKind: "legal",
          citations: laterResult.citations, citationClaim: laterResult.citationClaim },
      ] });
    const completedAt = submittedAt + 90_000;
    vi.setSystemTime(completedAt);
    expect((await f.worker(job.jobId, "commit", input)).status).toBe("ok");
    const history = await f.owner.query(api.chats.listMessages, { externalId: f.args.externalId,
      paginationOpts: { numItems: 10, cursor: null } });
    expect(history.isDone).toBe(true);
    expect.soft(history.page.map(message => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: f.payload.query }, { role: "assistant", content: answer },
      { role: "user", content: laterQuestion }, { role: "assistant", content: laterAnswer },
    ]);
    expect.soft(history.page.map(message => message.createdAt)).toEqual([submittedAt, submittedAt, laterAt, laterAt]);
    const session = await f.owner.query(api.chats.getByExternalId, { externalId: f.args.externalId });
    expect.soft(session).toMatchObject({ lastMessage: laterAnswer, messageCount: 4, timestamp: completedAt });
    expect(await f.worker(job.jobId, "commit", input)).toEqual({ status: "ignored", payload: null });
  });
  it.each(["DEV", "production"] as const)("commits only the passed candidate and persists both exact messages with consumed provenance claim on %s", async environment => {
    if (environment === "production") productionEnvironment();
    const f = await fixture(), job = await f.submit(), sourceBinding = f.sourceBinding; expect((await f.worker(job.jobId, "claim")).status).toBe("ok");
    const pageNumber = environment === "production" ? 18 : 11;
    const answer = "This reviewed edition requires written consent before the arrangement.";
    const answerSha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(answer))))
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const input = {
      completion: { routeNonce: f.payload.routeNonce, externalId: f.args.externalId, jurisdictionId: f.ids.jurisdictionId,
        assistantClientId: f.args.assistantClientId, finalAnswer: answer, answerKind: "legal", outcome: "success",
        citations: [{ jurisdictionId: f.ids.jurisdictionId, resourceId: f.ids.resourceId, versionId: f.ids.versionId,
          providerStoreName: f.ids.storeName, pageNumber }], model: "reviewed-background-fixture", elapsedMs: 1000,
        authorizedScopeSize: 1, readyStoreCount: 1, partialCoverage: false,
        jurisdictionCoverage: [{ ordinal: 0, relation: "selected", coverage: "evidence" }], attachmentIds: [] },
      source: { jurisdictionId: f.ids.jurisdictionId, resourceId: f.ids.resourceId, versionId: f.ids.versionId,
        expectedSha256: f.ids.expectedSha256, expectedByteSize: f.ids.expectedByteSize, asOfDate: new Date().toISOString().slice(0, 10) },
      user: { clientId: f.args.userClientId, content: f.payload.query, attachmentIds: [] },
    };
    expect((await f.worker(job.jobId, "commit", input)).status).toBe("ignored");
    for (const stage of ["draft", "inventory", "consent", "overtime"]) {
      const reservation = { stage, requestSha256, candidateSha256: stage === "draft" ? null : answerSha, sourceBinding };
      expect((await f.worker(job.jobId, "reserve", reservation)).status).toBe("ok");
      expect((await f.worker(job.jobId, "passed", { ...reservation, candidateSha256: answerSha })).status).toBe("ok");
    }
    if (environment === "production") {
      productionEnvironment(false, false);
      expect(await f.worker(job.jobId, "commit", input)).toEqual({ status: "ignored", payload: null });
      expect(await f.t.run(ctx => ctx.db.query("messages").take(3))).toEqual([]);
      productionEnvironment(false, true);
    }
    expect((await f.worker(job.jobId, "commit", { ...input, completion: { ...input.completion, finalAnswer: "changed answer" } })).status).toBe("ignored");
    expect((await f.worker(job.jobId, "commit", { ...input, user: { ...input.user, content: "changed question" } })).status).toBe("ignored");
    await f.t.run(ctx => ctx.db.patch(f.ids.resourceId, { effectiveDate: "2002-01-01" }));
    expect((await f.worker(job.jobId, "commit", input)).status).toBe("ignored");
    expect(await f.t.run(ctx => ctx.db.query("messages").take(3))).toEqual([]);
    await f.t.run(ctx => ctx.db.patch(f.ids.resourceId, { effectiveDate: "2003-10-08" }));
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(job.verificationDeadlineAt + 1);
    const committed = await f.worker(job.jobId, "commit", input);
    expect(committed.status).toBe("ok");
    expect(JSON.parse(committed.payload)).toMatchObject({ status: "completed", outcome: "success", answerKind: "legal", persisted: true,
      citationClaim: expect.any(String), expiresAt: expect.any(Number), citations: expect.any(Array), partialCoverage: false });
    const state = await f.t.run(async ctx => ({ messages: await ctx.db.query("messages").take(4),
      claims: await ctx.db.query("chatCitationClaims").take(3), runs: await ctx.db.query("queryRuns").take(3) }));
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({ role: "user", content: f.payload.query, clientId: f.args.userClientId });
    expect(state.messages[1]).toMatchObject({ role: "assistant", content: answer, clientId: f.args.assistantClientId,
      answerKind: "legal", reviewedOriginalSource: { versionId: f.ids.versionId, pageNumbers: [pageNumber] } });
    expect(state.claims).toEqual([]); expect(state.runs).toHaveLength(1);
    expect(await f.owner.query(getRef, { externalId: f.args.externalId })).toMatchObject({ status: "succeeded", progress: "complete" });
    expect(await f.worker(job.jobId, "commit", input)).toEqual({ status: "ignored", payload: null });
  });
  it("blocks fresh worker authority when the captured native session expires", async () => {
    const f = await fixture(), job = await f.submit(), sourceBinding = f.sourceBinding; expect((await f.worker(job.jobId, "claim")).status).toBe("ok");
    await f.t.run(ctx => ctx.runMutation(components.betterAuth.adapter.updateOne, { input: { model: "session",
      where: [{ field: "_id", value: f.ids.identity.sessionId }], update: { expiresAt: Date.now() - 1 } } }));
    expect(await f.worker(job.jobId, "authority")).toEqual({ status: "ignored", payload: null });
    expect(await f.worker(job.jobId, "reserve", { stage: "draft", requestSha256, candidateSha256: null, sourceBinding })).toEqual({ status: "ignored", payload: null });
    expect(await f.t.run(ctx => ctx.db.query("reviewedEmploymentJobStages").take(4))).toEqual([]);
  });
  it("reserves the consent and overtime audits concurrently after inventory and waits for both passes", async () => {
    const f = await fixture(), job = await f.submit(), sourceBinding = f.sourceBinding; expect((await f.worker(job.jobId, "claim")).status).toBe("ok");
    for (const stage of ["draft", "inventory"]) {
      const reservation = { stage, requestSha256, candidateSha256: stage === "draft" ? null : candidateSha256, sourceBinding };
      expect((await f.worker(job.jobId, "reserve", reservation)).status).toBe("ok");
      expect((await f.worker(job.jobId, "passed", { ...reservation, candidateSha256 })).status).toBe("ok");
    }
    const consent = { stage: "consent", requestSha256, candidateSha256, sourceBinding };
    const overtime = { ...consent, stage: "overtime" };
    const reservations = await Promise.all([f.worker(job.jobId, "reserve", consent), f.worker(job.jobId, "reserve", overtime)]);
    expect(reservations.map(result => result.status)).toEqual(["ok", "ok"]);
    expect((await f.worker(job.jobId, "passed", overtime)).status).toBe("ok");
    expect(await f.owner.query(getRef, { externalId: f.args.externalId })).toMatchObject({ status: "running", progress: "consent" });
    expect((await f.worker(job.jobId, "passed", consent)).status).toBe("ok");
    expect(await f.owner.query(getRef, { externalId: f.args.externalId })).toMatchObject({ status: "running", progress: "commit" });
  });
  it("accepts only the closed client projection and rejects any private extra fields", async () => {
    const f = await fixture(), job = await f.submit(), sourceBinding = f.sourceBinding;
    const parse = (jobContracts as unknown as { parseReviewedEmploymentJobProjection?: (value: unknown) => unknown }).parseReviewedEmploymentJobProjection;
    expect(typeof parse).toBe("function");
    expect(parse!(job)).toEqual(job);
    for (const invalid of [{ ...job, candidate: "private" }, { ...job, createdAt: NaN }, { ...job, errorReason: "arbitrary" },
      { ...job, verificationDeadlineAt: job.createdAt - 1 }, { ...job, status: "unknown" }, { ...job, jobId: "" }]) expect(parse!(invalid)).toBeNull();
  });
  it.each([{ banned: true }, { emailVerified: false }])("rejects an ineligible native owner before creating a job or charging quota: %j", async update => {
    const f = await fixture();
    await f.t.run(ctx => ctx.runMutation(components.betterAuth.adapter.updateOne, { input: { model: "user",
      where: [{ field: "_id", value: f.ids.identity.subject }], update } }));
    await expect(f.submit()).rejects.toThrow();
    expect(await f.t.run(ctx => ctx.db.query("reviewedEmploymentJobs").take(3))).toEqual([]);
    expect(await f.t.run(ctx => ctx.db.query("dailyUsage").take(3))).toEqual([]);
  });
  it("canonicalizes the source bundle independently of object key order while retaining array order", () => {
    const canonical = (jobContracts as unknown as { reviewedEmploymentSourceBundleCanonicalJson?: (value: { source: unknown; manifest: unknown }) => string }).reviewedEmploymentSourceBundleCanonicalJson;
    expect(typeof canonical).toBe("function");
    expect(canonical!({ source: { b: 2, a: 1 }, manifest: { stores: [{ z: 3, a: 4 }, "second"] } }))
      .toBe(canonical!({ manifest: { stores: [{ a: 4, z: 3 }, "second"] }, source: { a: 1, b: 2 } }));
    expect(canonical!({ source: null, manifest: { stores: ["first", "second"] } }))
      .not.toBe(canonical!({ source: null, manifest: { stores: ["second", "first"] } }));
  });
  it("erases retained background submission and stage records in bounded batches when the owner deletes the chat", async () => {
    const f = await fixture(), job = await f.submit(), sourceBinding = f.sourceBinding; expect((await f.worker(job.jobId, "claim")).status).toBe("ok");
    const reservation = { stage: "draft", requestSha256, candidateSha256: null, sourceBinding };
    expect((await f.worker(job.jobId, "reserve", reservation)).status).toBe("ok");
    await f.t.run(async ctx => {
      const original = (await ctx.db.get(job.jobId as Id<"reviewedEmploymentJobs">))!;
      const { _id: _id, _creationTime: _time, ...retained } = original;
      for (let index = 0; index < 30; index++) {
        const historical = await ctx.db.insert("reviewedEmploymentJobs", { ...retained,
          submissionId: `historical-${index}`, assistantClientId: `historical-${index}`, status: "blocked" });
        await ctx.db.insert("reviewedEmploymentJobStages", { jobId: historical, ...reservation,
          stage: "draft", status: "reserved", reservedAt: Date.now() });
      }
    });
    vi.useFakeTimers();
    expect(await f.owner.mutation(api.chats.remove, { externalId: f.args.externalId })).toEqual({ deleted: true });
    expect(await f.worker(job.jobId, "authority")).toEqual({ status: "ignored", payload: null });
    expect(await f.worker(job.jobId, "passed", { ...reservation, candidateSha256 })).toEqual({ status: "ignored", payload: null });
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await f.t.run(ctx => ctx.db.query("reviewedEmploymentJobs").take(40))).toEqual([]);
    expect(await f.t.run(ctx => ctx.db.query("reviewedEmploymentJobStages").take(40))).toEqual([]);
    expect(await f.worker(job.jobId, "commit", {})).toEqual({ status: "ignored", payload: null });
  });
  it("returns an exact older job only to its current owner and chat while default lookup follows the latest", async () => {
    const f = await fixture(), previous = await f.submit();
    await f.owner.mutation(cancelRef, { jobId: previous.jobId });
    const latest = await f.submit({ submissionId: "answer-2", assistantClientId: "answer-2", userClientId: "question-2",
      submission: JSON.stringify({ ...f.payload, routeNonce: createOpaqueTelemetryToken() }) });
    expect(await f.owner.query(getRef, { externalId: f.args.externalId })).toEqual(latest);
    const exact = { externalId: f.args.externalId, jobId: previous.jobId };
    expect(await f.owner.query(getRef, exact)).toMatchObject({ jobId: previous.jobId, status: "cancelled" });
    expect(await f.other.query(getRef, exact)).toBeNull();
    expect(await f.t.query(getRef, exact)).toBeNull();
    await f.owner.mutation(api.chats.ensure, { externalId: "another-chat", jurisdictionId: f.ids.jurisdictionId });
    expect(await f.owner.query(getRef, { ...exact, externalId: "another-chat" })).toBeNull();
  });
  it("does not replay a retained submission into a replacement chat session before cleanup runs", async () => {
    const f = await fixture(); await f.submit();
    vi.useFakeTimers();
    await f.owner.mutation(api.chats.remove, { externalId: f.args.externalId });
    await f.owner.mutation(api.chats.ensure, { externalId: f.args.externalId, jurisdictionId: f.ids.jurisdictionId });
    await expect(f.submit()).rejects.toThrow("REVIEWED_EMPLOYMENT_JOB_CONFLICT");
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});
