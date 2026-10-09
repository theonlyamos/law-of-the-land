/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import authSchema from "./betterAuth/schema";
import schema from "./schema";
import * as chats from "./chats";
import * as reviewedCompletion from "./reviewedEmploymentCompletion";
import * as reviewedSource from "./reviewedEmployment";
import { createOpaqueTelemetryToken, createTelemetryServiceProof } from "./lib/telemetryProof";
import { reviewedEmploymentCommitProofParts, type ReviewedEmploymentCommitInput } from "./reviewedEmploymentCompletion";

// Only the deployment-specific fixed catalog is replaced with synthetic fixture
// IDs/bytes. Authentication, authorization, completion and persistence are real.
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
const commitRef = makeFunctionReference<"mutation">("reviewedEmploymentCompletion:commit");
const authorizeRef = makeFunctionReference<"query">("reviewedEmployment:authorizeSource");
const citationFileRef = makeFunctionReference<"action">("reviewedEmployment:resolveCitationFile");
const prepareRef = makeFunctionReference<"mutation">("chatAttachments:prepareUpload");
const finalizeRef = makeFunctionReference<"mutation">("chatAttachments:finalizeUpload");
const ANSWER = "The supplied reviewed edition requires written notice in this scenario.";
function productionEnvironment(admission = true, execution = true) {
  vi.stubEnv("CONVEX_CLOUD_URL", "https://loyal-koala-720.eu-west-1.convex.cloud");
  vi.stubEnv("CONVEX_SITE_URL", "https://loyal-koala-720.eu-west-1.convex.site");
  vi.stubEnv("REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED", admission ? "1" : undefined);
  vi.stubEnv("REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED", execution ? "1" : undefined);
}
type Backend = TestConvex<typeof schema>;

async function fixture() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
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
    const identity = await account("employment-commit-owner"), otherIdentity = await account("employment-commit-other");
    await ctx.db.insert("featureFlags", { key: "unified_jurisdictions", environment: "test", enabled: true, updatedAt: now });
    const storeName = "fileSearchStores/employment-commit-fixture";
    const jurisdictionId = await ctx.db.insert("jurisdictions", { name: "Synthetic employment jurisdiction", slug: "employment-commit",
      status: "enabled", kind: "geographic", visibility: "public", isDefault: false, providerSyncState: "synced",
      geminiFileSearchStoreName: storeName, createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now });
    await ctx.db.insert("geographicJurisdictions", { jurisdictionId, googlePlaceId: "employment-commit-place", level: "country",
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
  const owner = t.withIdentity(ids.identity), other = t.withIdentity(ids.otherIdentity), externalId = "employment-commit-session";
  await owner.mutation(api.chats.ensure, { externalId, jurisdictionId: ids.jurisdictionId });
  const input: ReviewedEmploymentCommitInput = {
    completion: { routeNonce: createOpaqueTelemetryToken(), externalId, jurisdictionId: ids.jurisdictionId,
      assistantClientId: "answer-1", finalAnswer: ANSWER, answerKind: "legal", outcome: "success",
      citations: [{ jurisdictionId: ids.jurisdictionId, resourceId: ids.resourceId, versionId: ids.versionId,
        providerStoreName: ids.storeName, pageNumber: 11 }], model: "reviewed-fixture", elapsedMs: 1000,
      authorizedScopeSize: 1, readyStoreCount: 1, partialCoverage: false,
      jurisdictionCoverage: [{ ordinal: 0, relation: "selected", coverage: "evidence" }], attachmentIds: [] },
    source: { jurisdictionId: ids.jurisdictionId, resourceId: ids.resourceId, versionId: ids.versionId,
      expectedSha256: ids.expectedSha256, expectedByteSize: ids.expectedByteSize, asOfDate: new Date().toISOString().slice(0, 10) },
    user: { clientId: "question-1", content: "Do I need written notice?", attachmentIds: [] },
  };
  const signed = async () => ({ ...input, serviceProof: await createTelemetryServiceProof(await reviewedEmploymentCommitProofParts(input)) });
  const commit = async () => owner.mutation(commitRef, await signed());
  return { t, owner, other, ids, input, commit, signed };
}
async function state(t: Backend) {
  return t.run(async ctx => ({ claims: await ctx.db.query("chatCitationClaims").take(3),
    runs: await ctx.db.query("queryRuns").take(3), messages: await ctx.db.query("messages").take(5) }));
}
async function attachment(f: Awaited<ReturnType<typeof fixture>>, text: string) {
  const { attachmentId } = await f.owner.mutation(prepareRef, { externalId: f.input.completion.externalId,
    filename: "facts.txt", mimeType: "text/plain", byteSize: new TextEncoder().encode(text).length });
  const storageId = await f.t.run(ctx => ctx.storage.store(new Blob([text], { type: "text/plain" })));
  await f.owner.mutation(finalizeRef, { attachmentId, storageId, mimeType: "text/plain", kind: "text", extractedText: text });
  return attachmentId as Id<"chatAttachments">;
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CONVEX_CLOUD_URL", undefined);
  vi.stubEnv("CONVEX_SITE_URL", undefined);
  vi.stubEnv("ADMIN_ENVIRONMENT", "test");
  vi.stubEnv("TELEMETRY_INGEST_SECRET", "employment-atomic-fixture-secret-at-least-32-characters");
});
afterEach(() => vi.unstubAllEnvs());

describe("reviewed employment trusted job principal", () => {
  async function binding(f: Awaited<ReturnType<typeof fixture>>) {
    const session = await f.t.run(ctx => ctx.db.query("chatSessions").withIndex("by_user_externalId", q =>
      q.eq("userId", f.ids.identity.subject).eq("externalId", f.input.completion.externalId)).unique());
    return { ownerId: f.ids.identity.subject, nativeAuthSessionId: f.ids.identity.sessionId,
      sessionId: session!._id, externalId: f.input.completion.externalId, jurisdictionId: f.ids.jurisdictionId };
  }
  async function jobCommit(f: Awaited<ReturnType<typeof fixture>>, storedBinding?: Awaited<ReturnType<typeof binding>>) {
    expect(chats.requireReviewedEmploymentJobPrincipal).toBeTypeOf("function");
    expect(reviewedCompletion.commitReviewedEmploymentForJobPrincipal).toBeTypeOf("function");
    const principalBinding = storedBinding ?? await binding(f), signed = await f.signed();
    return f.t.run(async ctx => reviewedCompletion.commitReviewedEmploymentForJobPrincipal(ctx, signed,
      await chats.requireReviewedEmploymentJobPrincipal(ctx, principalBinding)));
  }
  it("rejects direct production completion outside the job stage boundary without any persistence", async () => {
    productionEnvironment();
    const f = await fixture();
    f.input.completion.citations[0].pageNumber = 18;
    await expect(f.commit()).rejects.toThrow("REVIEWED_EMPLOYMENT_COMMIT_INVALID");
    expect(await state(f.t)).toEqual({ claims: [], runs: [], messages: [] });
  });
  it("stops production atomic completion independently of owner reads when execution is disabled", async () => {
    productionEnvironment();
    const f = await fixture();
    f.input.completion.citations[0].pageNumber = 18;
    productionEnvironment(false, false);
    await expect(jobCommit(f)).rejects.toThrow("REVIEWED_EMPLOYMENT_COMMIT_INVALID");
    expect(await state(f.t)).toEqual({ claims: [], runs: [], messages: [] });
  });
  it("limits production provenance to page 18 and keeps a saved original readable after both controls are disabled", async () => {
    productionEnvironment();
    const f = await fixture();
    await expect(jobCommit(f)).rejects.toThrow("REVIEWED_EMPLOYMENT_COMMIT_INVALID");
    expect(await state(f.t)).toEqual({ claims: [], runs: [], messages: [] });
    f.input.completion.citations[0].pageNumber = 18;
    expect(await jobCommit(f)).toMatchObject({ status: "completed", persisted: true });
    const saved = await state(f.t), assistant = saved.messages.find(message => message.role === "assistant")!;
    expect(assistant.reviewedOriginalSource).toEqual({ ...policy, pageNumbers: [18] });
    productionEnvironment(false, false);
    expect(await f.owner.action(citationFileRef, { externalId: f.input.completion.externalId,
      messageId: assistant._id, citationIndex: 0 })).toMatchObject({ filename: "fixture.pdf", mimeType: "application/pdf", byteSize: policy.expectedByteSize });
    expect(await f.other.action(citationFileRef, { externalId: f.input.completion.externalId,
      messageId: assistant._id, citationIndex: 0 })).toBeNull();
  });
  it("atomically persists without a browser request identity", async () => {
    const f = await fixture(), result = await jobCommit(f), saved = await state(f.t);
    expect(result).toMatchObject({ status: "completed", persisted: true, answerKind: "legal" });
    expect(saved.claims).toEqual([]);
    expect(saved.runs).toHaveLength(1);
    expect(saved.messages.map(message => ({ role: message.role, clientId: message.clientId, content: message.content })))
      .toEqual([{ role: "user", clientId: f.input.user.clientId, content: f.input.user.content },
        { role: "assistant", clientId: f.input.completion.assistantClientId, content: ANSWER }]);
    expect(saved.messages[1].reviewedOriginalSource).toEqual({ ...policy, pageNumbers: [11] });
  });
  it.each(["native session expired", "native session replaced", "owner banned", "owner unverified", "chat owner changed", "jurisdiction withdrawn"] as const)(
    "fails closed when %s changes after submission", async change => {
      const f = await fixture(), principalBinding = await binding(f);
      await f.t.run(async ctx => {
        if (change === "native session expired" || change === "native session replaced") {
          await ctx.runMutation(components.betterAuth.adapter.updateOne, { input: { model: "session",
            where: [{ field: "_id", value: f.ids.identity.sessionId }], update: change === "native session expired"
              ? { expiresAt: Date.now() - 1 } : { userId: f.ids.otherIdentity.subject } } });
        } else if (change === "owner banned" || change === "owner unverified") {
          await ctx.runMutation(components.betterAuth.adapter.updateOne, { input: { model: "user",
            where: [{ field: "_id", value: f.ids.identity.subject }], update: change === "owner banned"
              ? { banned: true } : { emailVerified: false } } });
        } else if (change === "chat owner changed") await ctx.db.patch(principalBinding.sessionId, { userId: f.ids.otherIdentity.subject });
        else await ctx.db.patch(f.ids.jurisdictionId, { status: "archived" });
      });
      await expect(jobCommit(f, principalBinding)).rejects.toThrow("REVIEWED_EMPLOYMENT_JOB_PRINCIPAL_UNAVAILABLE");
      expect(await state(f.t)).toEqual({ claims: [], runs: [], messages: [] });
    });
  it("rejects a mismatched session and forged helper principal", async () => {
    const f = await fixture(), principalBinding = await binding(f);
    await expect(jobCommit(f, { ...principalBinding, nativeAuthSessionId: f.ids.otherIdentity.sessionId }))
      .rejects.toThrow("REVIEWED_EMPLOYMENT_JOB_PRINCIPAL_UNAVAILABLE");
    expect(reviewedCompletion.commitReviewedEmploymentForJobPrincipal).toBeTypeOf("function");
    const signed = await f.signed();
    await expect(f.t.run(ctx => reviewedCompletion.commitReviewedEmploymentForJobPrincipal(ctx, signed,
      {} as chats.VerifiedReviewedEmploymentJobPrincipal))).rejects.toThrow("REVIEWED_EMPLOYMENT_JOB_PRINCIPAL_UNAVAILABLE");
    expect(await state(f.t)).toEqual({ claims: [], runs: [], messages: [] });
  });
  it("rechecks a previously granted principal at commit", async () => {
    const f = await fixture(), principalBinding = await binding(f), signed = await f.signed();
    expect(chats.requireReviewedEmploymentJobPrincipal).toBeTypeOf("function");
    let granted!: chats.VerifiedReviewedEmploymentJobPrincipal;
    await f.t.run(async ctx => { granted = await chats.requireReviewedEmploymentJobPrincipal(ctx, principalBinding); });
    await f.t.run(ctx => ctx.runMutation(components.betterAuth.adapter.updateOne, { input: { model: "session",
      where: [{ field: "_id", value: f.ids.identity.sessionId }], update: { expiresAt: Date.now() - 1 } } }));
    await expect(f.t.run(ctx => reviewedCompletion.commitReviewedEmploymentForJobPrincipal(ctx, signed, granted)))
      .rejects.toThrow("REVIEWED_EMPLOYMENT_JOB_PRINCIPAL_UNAVAILABLE");
    expect(await state(f.t)).toEqual({ claims: [], runs: [], messages: [] });
  });
  it("reuses current source checks without a browser identity", async () => {
    const f = await fixture(), principalBinding = await binding(f);
    expect(reviewedSource.authorizeSourceForJobPrincipal).toBeTypeOf("function");
    const grant = () => f.t.run(async ctx => reviewedSource.authorizeSourceForJobPrincipal(ctx,
      { externalId: f.input.completion.externalId, ...f.input.source },
      await chats.requireReviewedEmploymentJobPrincipal(ctx, principalBinding)));
    expect(await grant()).toMatchObject({ status: "authorized", sha256: f.ids.expectedSha256 });
    await f.t.run(ctx => ctx.db.patch(f.ids.resourceId, { catalogPublished: false }));
    expect(await grant()).toEqual({ status: "unavailable" });
  });
  it("rolls back every commit write when a saved user client ID conflicts", async () => {
    const f = await fixture();
    await f.owner.mutation(api.chats.appendMessages, { externalId: f.input.completion.externalId, lastMessage: "Prior content",
      messages: [{ role: "user", clientId: f.input.user.clientId, content: "Prior content" }] });
    const before = await state(f.t);
    await expect(jobCommit(f)).rejects.toThrow("CHAT_CLIENT_ID_CONFLICT");
    expect(await state(f.t)).toEqual(before);
  });
});

describe("reviewed employment atomic commit", () => {
  it("pins the real server policy to the exact reviewed ACT 651 edition", async () => {
    const actual = await vi.importActual<typeof import("../shared/reviewed-employment-policy")>("../shared/reviewed-employment-policy");
    expect(actual.REVIEWED_EMPLOYMENT_POLICY).toEqual({ jurisdictionId: "md744z756x2etfcscnx9ayys8n8dp2mc",
      resourceId: "mh72janpeqm7zpa406pm1hxwvx8dpvr2", versionId: "kh70hvbgwbfnrsjhsxhcc9m56x8dp9rw",
      expectedSha256: "125e8ce4d70beb6fbe6adc5f9cbaec27dc435c484a62b3eee38bf80cff466f5a", expectedByteSize: 1913139 });
  });

  it("completes and persists the exact answer for an ordinary owner in one transaction", async () => {
    const f = await fixture(), startedAt = Date.now(), result = await f.commit(), completedAt = Date.now(), saved = await state(f.t);
    expect(result).toMatchObject({ status: "completed", outcome: "success", answerKind: "legal", persisted: true,
      citations: [{ label: "Synthetic Employment Act, page 11", jurisdictionId: f.ids.jurisdictionId }] });
    expect(saved.claims).toEqual([]);
    expect(saved.runs).toHaveLength(1);
    expect(saved.messages).toHaveLength(2);
    for (const message of saved.messages) {
      expect(message.createdAt).toBeGreaterThanOrEqual(startedAt);
      expect(message.createdAt).toBeLessThanOrEqual(completedAt);
    }
    expect(saved.messages.map(message => ({ role: message.role, clientId: message.clientId, content: message.content })))
      .toEqual([{ role: "user", clientId: f.input.user.clientId, content: f.input.user.content },
        { role: "assistant", clientId: f.input.completion.assistantClientId, content: ANSWER }]);
    for (const secret of [f.ids.storeName, f.ids.originalStorageId, "serviceProof", "https://"]) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("reloads the committed turn through the owner's public message query with exact citations and duration", async () => {
    const f = await fixture(), result = await f.commit(), saved = await state(f.t);
    const reloaded = await f.owner.query(api.chats.listMessages, {
      externalId: f.input.completion.externalId, paginationOpts: { numItems: 10, cursor: null },
    });
    expect(reloaded.isDone).toBe(true);
    expect(reloaded.page).toHaveLength(2);
    expect(reloaded.page.map(message => ({ storageId: message.storageId, clientId: message.clientId,
      role: message.role, content: message.content }))).toEqual([
      { storageId: saved.messages.find(message => message.role === "user")!._id,
        clientId: f.input.user.clientId, role: "user", content: f.input.user.content },
      { storageId: saved.messages.find(message => message.role === "assistant")!._id,
        clientId: f.input.completion.assistantClientId, role: "assistant", content: f.input.completion.finalAnswer },
    ]);
    expect(reloaded.page[1]).toMatchObject({ answerKind: "legal", citations: result.citations,
      completedAt: saved.runs[0].completedAt, durationMs: f.input.completion.elapsedMs });
    expect(reloaded.page[1].citations).toEqual([{ label: "Synthetic Employment Act, page 11",
      jurisdictionId: f.ids.jurisdictionId, jurisdictionName: "Synthetic employment jurisdiction",
      jurisdictionKind: "geographic", relation: "selected" }]);
    expect(reloaded.page[1]).toHaveProperty("originalSourceUrls", [
      `/api/chat/sources/${saved.messages.find(message => message.role === "assistant")!._id}/0?chat=${f.input.completion.externalId}#page=11`,
    ]);
    for (const secret of [f.ids.storeName, f.ids.originalStorageId, "serviceProof", "citationClaim"])
      expect(JSON.stringify(reloaded)).not.toContain(secret);
  });

  it.each(["another owner", "anonymous"] as const)("does not disclose a committed reviewed turn to %s", async reader => {
    const f = await fixture(); await f.commit();
    const client = reader === "another owner" ? f.other : f.t;
    expect(await client.query(api.chats.listMessages, {
      externalId: f.input.completion.externalId, paginationOpts: { numItems: 10, cursor: null },
    })).toEqual({ page: [], isDone: true, continueCursor: "" });
  });

  it("opens only the exact committed original for the current ordinary owner", async () => {
    const f = await fixture(); await f.commit();
    const saved = await state(f.t), assistant = saved.messages.find(message => message.role === "assistant")!;
    const args = { externalId: f.input.completion.externalId, messageId: assistant._id, citationIndex: 0 };
    const file = await f.owner.action(citationFileRef, args);
    expect(file).toMatchObject({ filename: "fixture.pdf", mimeType: "application/pdf", byteSize: f.ids.expectedByteSize });
    expect(file.url).toEqual(await f.t.run(ctx => ctx.storage.getUrl(f.ids.originalStorageId)));
    expect(await f.other.action(citationFileRef, args)).toBeNull();
    expect(await f.t.action(citationFileRef, args)).toBeNull();
    expect(await f.owner.action(citationFileRef, { ...args, externalId: "different-session" })).toBeNull();
    expect(await f.owner.action(citationFileRef, { ...args, messageId: saved.messages.find(message => message.role === "user")!._id })).toBeNull();
    for (const citationIndex of [-1, 0.5, 1, 4, 1000])
      expect(await f.owner.action(citationFileRef, { ...args, citationIndex })).toBeNull();
  });

  it.each(["catalog withdrawn", "version drift", "original replaced", "lifecycle lock", "session access revoked"] as const)(
    "rechecks %s when opening a previously committed citation", async change => {
      const f = await fixture(); await f.commit();
      const assistant = (await state(f.t)).messages.find(message => message.role === "assistant")!;
      const args = { externalId: f.input.completion.externalId, messageId: assistant._id, citationIndex: 0 };
      expect(await f.owner.action(citationFileRef, args)).not.toBeNull();
      await f.t.run(async ctx => {
        if (change === "catalog withdrawn") await ctx.db.patch(f.ids.resourceId, { catalogPublished: false });
        else if (change === "version drift") await ctx.db.patch(f.ids.versionId, { sha256: "a".repeat(64) });
        else if (change === "original replaced") {
          const replacement = await ctx.storage.store(new Blob(["x".repeat(f.ids.expectedByteSize)], { type: "application/pdf" }));
          await ctx.db.patch(f.ids.versionId, { originalStorageId: replacement });
        } else if (change === "session access revoked") await ctx.db.patch(f.ids.jurisdictionId, { status: "archived" });
        else await ctx.db.insert("documentLifecycleLocks", { resourceId: f.ids.resourceId, versionId: f.ids.versionId,
          jurisdictionId: f.ids.jurisdictionId, operation: "unpublish", actorId: "fixture", idempotencyKey: "source-lock",
          expiresAt: Date.now() + 60_000, createdAt: Date.now(), updatedAt: Date.now() });
      });
      expect(await f.owner.action(citationFileRef, args)).toBeNull();
    },
  );

  it("denies original grants after the native owner session expires", async () => {
    const f = await fixture(); await f.commit();
    const assistant = (await state(f.t)).messages.find(message => message.role === "assistant")!;
    const args = { externalId: f.input.completion.externalId, messageId: assistant._id, citationIndex: 0 };
    expect(await f.owner.action(citationFileRef, args)).not.toBeNull();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 2 * 86_400_000);
      expect(await f.owner.action(citationFileRef, args)).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("keeps legacy citations as labels and rejects caller-supplied original provenance", async () => {
    const f = await fixture(); await f.commit();
    const assistant = (await state(f.t)).messages.find(message => message.role === "assistant")!;
    await f.t.run(ctx => ctx.db.patch(assistant._id, { reviewedOriginalSource: undefined }));
    const reloaded = await f.owner.query(api.chats.listMessages, {
      externalId: f.input.completion.externalId, paginationOpts: { numItems: 10, cursor: null },
    });
    expect(reloaded.page[1]).not.toHaveProperty("originalSourceUrls");
    expect(await f.owner.action(citationFileRef, {
      externalId: f.input.completion.externalId, messageId: assistant._id, citationIndex: 0,
    })).toBeNull();
    await expect(f.owner.mutation(makeFunctionReference<"mutation">("chats:appendMessages"), {
      externalId: f.input.completion.externalId, lastMessage: "forged provenance", messages: [{ role: "user",
        content: "forged provenance", clientId: "forged", reviewedOriginalSource: { ...f.input.source, pageNumbers: [11] } }],
    })).rejects.toThrow();
    expect((await state(f.t)).messages).toHaveLength(2);
  });

  it.each(["catalog", "hash", "effective date", "repeal date", "storage", "lifecycle lock", "session access"] as const)(
    "rejects changed %s after a successful preflight without persisting anything", async change => {
      const f = await fixture();
      expect(await f.owner.query(authorizeRef, { externalId: f.input.completion.externalId, ...f.input.source })).toMatchObject({ status: "authorized" });
      const signed = await f.signed();
      await f.t.run(async ctx => {
        if (change === "catalog") await ctx.db.patch(f.ids.resourceId, { catalogPublished: false });
        else if (change === "hash") await ctx.db.patch(f.ids.versionId, { sha256: "a".repeat(64) });
        else if (change === "effective date") await ctx.db.patch(f.ids.resourceId, { effectiveDate: "9999-01-01" });
        else if (change === "repeal date") await ctx.db.patch(f.ids.versionId, { repealDate: "2000-01-01" });
        else if (change === "storage") await ctx.storage.delete(f.ids.originalStorageId);
        else if (change === "session access") await ctx.db.patch(f.ids.jurisdictionId, { status: "archived" });
        else await ctx.db.insert("documentLifecycleLocks", { resourceId: f.ids.resourceId, versionId: f.ids.versionId,
          jurisdictionId: f.ids.jurisdictionId, operation: "unpublish", actorId: "fixture", idempotencyKey: "atomic-lock",
          expiresAt: Date.now() + 60_000, createdAt: Date.now(), updatedAt: Date.now() });
      });
      await expect(f.owner.mutation(commitRef, signed)).rejects.toThrow("REVIEWED_EMPLOYMENT_AUTHORITY_UNAVAILABLE");
      expect(await state(f.t)).toEqual({ claims: [], runs: [], messages: [] });
    },
  );

  it("rolls back success telemetry and its claim when real append rejects a user ID conflict", async () => {
    const f = await fixture();
    await f.owner.mutation(api.chats.appendMessages, { externalId: f.input.completion.externalId, lastMessage: "Prior content",
      messages: [{ role: "user", clientId: f.input.user.clientId, content: "Prior content" }] });
    const before = await state(f.t);
    await expect(f.commit()).rejects.toThrow("CHAT_CLIENT_ID_CONFLICT");
    expect(await state(f.t)).toEqual(before);
  });

  it.each(["user content", "user ID", "source hash", "source date", "answer", "resolved attachments", "new attachments"] as const)(
    "binds %s in the service proof", async change => {
      const f = await fixture(), id = await attachment(f, "private facts"), signed = await f.signed();
      if (change === "user content") signed.user = { ...signed.user, content: "Altered question" };
      else if (change === "user ID") signed.user = { ...signed.user, clientId: "different-user-message" };
      else if (change === "source hash") signed.source = { ...signed.source, expectedSha256: "b".repeat(64) };
      else if (change === "source date") signed.source = { ...signed.source, asOfDate: "2000-01-01" };
      else if (change === "answer") signed.completion = { ...signed.completion, finalAnswer: "Altered answer" };
      else if (change === "resolved attachments") signed.completion = { ...signed.completion, attachmentIds: [id] };
      else signed.user = { ...signed.user, attachmentIds: [id] };
      await expect(f.owner.mutation(commitRef, signed)).rejects.toThrow("REVIEWED_EMPLOYMENT_SERVICE_PROOF_INVALID");
      expect(await state(f.t)).toEqual({ claims: [], runs: [], messages: [] });
    },
  );

  it("requires a real current owner even with a valid service proof", async () => {
    const f = await fixture(), signed = await f.signed();
    await expect(f.other.mutation(commitRef, signed)).rejects.toThrow();
    await expect(f.t.mutation(commitRef, signed)).rejects.toThrow();
    expect(await state(f.t)).toEqual({ claims: [], runs: [], messages: [] });
  });

  it("binds all attachment context while only attaching newly submitted files to this user message", async () => {
    const f = await fixture(), prior = await attachment(f, "earlier facts"), current = await attachment(f, "new facts");
    await f.owner.mutation(api.chats.appendMessages, { externalId: f.input.completion.externalId, lastMessage: "Earlier question",
      messages: [{ role: "user", clientId: "prior-question", content: "Earlier question", attachmentIds: [prior] }] });
    f.input.completion.attachmentIds = [prior, current]; f.input.user.attachmentIds = [current];
    expect(await f.commit()).toMatchObject({ persisted: true });
    const saved = await state(f.t);
    expect(saved.claims).toEqual([]);
    expect(saved.messages.find(message => message.clientId === f.input.user.clientId)?.attachmentIds).toEqual([current]);
    expect(await f.t.run(ctx => ctx.db.get(prior))).toMatchObject({ messageClientId: "prior-question" });
    expect(await f.t.run(ctx => ctx.db.get(current))).toMatchObject({ messageClientId: f.input.user.clientId });
  });

  it("rejects a newly attached file omitted from the proof-bound completion context", async () => {
    const f = await fixture(); f.input.user.attachmentIds = [await attachment(f, "new facts")];
    await expect(f.commit()).rejects.toThrow();
    expect(await state(f.t)).toEqual({ claims: [], runs: [], messages: [] });
  });

  it("checks revoked prior attachments inside the atomic completion", async () => {
    const f = await fixture(), id = await attachment(f, "prior facts");
    f.input.completion.attachmentIds = [id];
    const signed = await f.signed();
    await f.t.run(ctx => ctx.db.delete(id));
    await expect(f.owner.mutation(commitRef, signed)).rejects.toThrow();
    expect(await state(f.t)).toEqual({ claims: [], runs: [], messages: [] });
  });

  it("rejects a replay without manufacturing a fresh claim or duplicating persisted messages", async () => {
    const f = await fixture(), signed = await f.signed();
    await f.owner.mutation(commitRef, signed);
    const before = await state(f.t);
    await expect(f.owner.mutation(commitRef, signed)).rejects.toThrow("REVIEWED_EMPLOYMENT_REPLAY_UNAVAILABLE");
    expect(await state(f.t)).toEqual(before);
  });

  it.each(["old date", "other source", "same message IDs", "long question", "long ID"] as const)(
    "rejects invalid proof-signed %s", async change => {
      const f = await fixture();
      if (change === "old date") f.input.source.asOfDate = "2000-01-01";
      else if (change === "other source") f.input.source.expectedSha256 = "b".repeat(64);
      else if (change === "same message IDs") f.input.user.clientId = f.input.completion.assistantClientId;
      else if (change === "long question") f.input.user.content = "a".repeat(4001);
      else f.input.user.clientId = "a".repeat(201);
      await expect(f.commit()).rejects.toThrow();
      expect(await state(f.t)).toEqual({ claims: [], runs: [], messages: [] });
    },
  );
});
