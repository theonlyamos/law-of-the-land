/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it } from "vitest";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import authSchema from "../betterAuth/schema";
import schema from "../schema";
import { validateSourceVerification, type SourceVerificationInput, UNRESOLVED_SOURCE_GUIDANCE } from "../lib/sourceVerification";
import { recordSourceVerificationForActor } from "./sourceVerification";

const modules = Object.fromEntries(Object.entries(import.meta.glob("../**/*.ts")).map(([path, load]) => [
  path.startsWith("../") ? `./${path.slice(3)}` : `./admin/${path.slice(2)}`, load,
]));
const authModules = Object.fromEntries(Object.entries(import.meta.glob("../betterAuth/**/*.ts")).map(([path, load]) => [`./${path.slice("../betterAuth/".length)}`, load]));
type Backend = TestConvex<typeof schema>;
const recordCorrection = makeFunctionReference<"mutation">("admin/sourceVerification:recordCorrection");
const listHistory = makeFunctionReference<"query">("admin/sourceVerification:listHistory");
const publishVersion = makeFunctionReference<"mutation">("admin/publication:publishVersion");
const actualUrl = "https://lawfirm.example/reproductions/case.pdf";
const reproduction: SourceVerificationInput = {
  sourceClass: "corroborated_reproduction", sourceUrl: actualUrl,
  verificationNotes: "Court text, citation and later treatment checked against independent court records.",
  corroboratingUrls: ["https://judicial.example/court-record/case"], completeOriginal: true, citationChecked: true, laterTreatmentChecked: true,
};

describe("source verification evidence validation", () => {
  it("accepts an explicitly assessed official source without inferring that classification from its host", () => {
    const official = { ...reproduction, sourceClass: "official_hosted" as const, corroboratingUrls: [] };
    expect(validateSourceVerification(official, actualUrl)).toEqual(official);
    expect(() => validateSourceVerification({ ...official, sourceClass: undefined } as unknown as SourceVerificationInput, actualUrl)).toThrow("DOCUMENT_SOURCE_CLASS_REQUIRED");
  });
  it("requires independent corroboration for a verified reproduction", () => {
    expect(validateSourceVerification(reproduction, actualUrl)).toEqual(reproduction);
    for (const corroboratingUrls of [[], [actualUrl], ["https://lawfirm.example:8443/case"], ["https://www.lawfirm.example/case"], ["https://lawfirm.example./case"]]) {
      expect(() => validateSourceVerification({ ...reproduction, corroboratingUrls }, actualUrl)).toThrow("DOCUMENT_SOURCE_INDEPENDENT_CORROBORATION_REQUIRED");
    }
  });
  it("rejects a different source path, query, fragment, protocol or credentials", () => {
    for (const sourceUrl of ["https://lawfirm.example/other.pdf", `${actualUrl}?other=1`, `${actualUrl}#page=2`, "http://lawfirm.example/reproductions/case.pdf", "https://user:pass@lawfirm.example/reproductions/case.pdf"]) {
      expect(() => validateSourceVerification({ ...reproduction, sourceUrl }, actualUrl)).toThrow();
    }
    expect(() => validateSourceVerification({ ...reproduction, corroboratingUrls: ["http://independent.example/case"] }, actualUrl)).toThrow("DOCUMENT_SOURCE_URL_INVALID");
  });
  it("requires substantive notes and all three explicit checks for verified evidence", () => {
    for (const field of ["completeOriginal", "citationChecked", "laterTreatmentChecked"] as const) {
      expect(() => validateSourceVerification({ ...reproduction, [field]: false }, actualUrl)).toThrow("DOCUMENT_SOURCE_CHECKS_INCOMPLETE");
    }
    for (const verificationNotes of ["brief", " ".repeat(25), "a".repeat(2001)]) {
      expect(() => validateSourceVerification({ ...reproduction, verificationNotes }, actualUrl)).toThrow("DOCUMENT_SOURCE_NOTES_REQUIRED");
    }
  });
  it("records uncertainty without inventing successful checks or independent corroboration", () => {
    const unresolved = { ...reproduction, completeOriginal: false, citationChecked: false, laterTreatmentChecked: false, corroboratingUrls: [] };
    expect(validateSourceVerification(unresolved, actualUrl, "unresolved")).toEqual(unresolved);
    expect(() => validateSourceVerification({ ...unresolved, verificationNotes: "uncertain" }, actualUrl, "unresolved")).toThrow("DOCUMENT_SOURCE_NOTES_REQUIRED");
  });
});

const oldEnvironment = { enabled: process.env.ADMIN_PANEL_ENABLED, env: process.env.ADMIN_ENVIRONMENT };
afterEach(() => {
  for (const [name, value] of Object.entries({ ADMIN_PANEL_ENABLED: oldEnvironment.enabled, ADMIN_ENVIRONMENT: oldEnvironment.env })) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
async function admin(t: Backend, role = "content_reviewer", assured = true) {
  const identity = await t.run(async ctx => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: {
      name: "Source reviewer", email: `${crypto.randomUUID()}@example.com`, emailVerified: true,
      createdAt: now, updatedAt: now, role, banned: false, twoFactorEnabled: true,
    } } });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "session", data: {
      token: crypto.randomUUID(), userId: user._id, expiresAt: now + 60_000, createdAt: now, updatedAt: now,
      ...(assured ? { adminTwoFactorVerifiedAt: now } : {}),
    } } });
    return { subject: user._id, sessionId: session._id };
  });
  return { client: t.withIdentity(identity), userId: identity.subject };
}
async function setup(status: "published" | "approved" | "unpublished" | "rejected" | "ready_for_review" | "publishing" | "superseded" = "published") {
  process.env.ADMIN_PANEL_ENABLED = "true";
  process.env.ADMIN_ENVIRONMENT = "test";
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  const ids = await t.run(async ctx => {
    const now = Date.now();
    await ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: now });
    const jurisdictionId = await ctx.db.insert("jurisdictions", { code: "GH", name: "Ghana", slug: "ghana", status: "enabled", isDefault: false,
      geminiFileSearchStoreName: "fileSearchStores/source-test", geminiEmbeddingModel: "models/gemini-embedding-2",
      providerSyncState: "synced", createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now });
    const resourceId = await ctx.db.insert("legalResources", { jurisdictionId, type: "judgment", title: "Mirror-hosted case", issuer: "Supreme Court",
      officialCitation: "[2012] Court 1", officialCitationKey: "[2012] court 1", sourceUrl: actualUrl, topics: [], status: "active",
      createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now });
    const storageId = await ctx.storage.store(new Blob(["abc"], { type: "application/pdf" }));
    const versionId = await ctx.db.insert("documentVersions", { resourceId, versionNumber: 1, originalStorageId: storageId,
      filename: "case.pdf", mimeType: "application/pdf", byteSize: 3, sha256: "a".repeat(64), sourceUrl: actualUrl,
      status, submittedBy: "legacy-importer", createdAt: now, updatedAt: now });
    const decisionId = await ctx.db.insert("reviewDecisions", { documentVersionId: versionId, reviewerId: "legacy-reviewer", decision: "approve",
      notes: "Original official-source assertion", checklistAnswers: { sourceAuthentic: true }, evaluationRunId: "legacy-evaluation",
      reason: "Legacy approval", correlationId: "legacy:source:approval", createdAt: now });
    return { versionId, decisionId };
  });
  const reviewer = await admin(t);
  return { t, reviewer, ...ids, args: { versionId: ids.versionId, sourceVerification: reproduction,
    reason: "Reclassify source based on independent evidence", idempotencyKey: "source-correction-1", assessment: "verified" as const } };
}

describe("append-only source verification history", () => {
  it("attaches verified superseded evidence without changing the original or legacy decision", async () => {
    const { t, reviewer, versionId, decisionId, args } = await setup("superseded");
    const before = await t.run(async ctx => ({ version: await ctx.db.get(versionId), decision: await ctx.db.get(decisionId) }));
    await expect(reviewer.client.mutation(recordCorrection, { ...args, sourceVerification: { ...reproduction, completeOriginal: false } })).rejects.toThrow("DOCUMENT_SOURCE_CHECKS_INCOMPLETE");
    const id = await reviewer.client.mutation(recordCorrection, args);
    expect(await reviewer.client.mutation(recordCorrection, args)).toBe(id);
    const after = await t.run(async ctx => ({ version: await ctx.db.get(versionId), decision: await ctx.db.get(decisionId), evidence: await ctx.db.get(id as Id<"documentSourceVerifications">) }));
    expect(after.version).toEqual(before.version); expect(after.decision).toEqual(before.decision);
    expect(after.evidence).toMatchObject({ assessment: "verified", kind: "correction", sourceClass: "corroborated_reproduction" });
  });
  it("denies superseded corrections without assured review and rollback authorization", async () => {
    const { t, args } = await setup("superseded");
    for (const role of ["content_manager", "auditor", "billing_manager"]) {
      const actor = await admin(t, role);
      await expect(actor.client.mutation(recordCorrection, args)).rejects.toThrow("ADMIN_FORBIDDEN");
    }
    const unassured = await admin(t, "content_reviewer", false);
    await expect(unassured.client.mutation(recordCorrection, args)).rejects.toThrow();
    await expect(t.mutation(recordCorrection, args)).rejects.toThrow("ADMIN_AUTH_REQUIRED");
    expect(await t.run(ctx => ctx.db.query("documentSourceVerifications").take(1))).toHaveLength(0);
  });
  it("adds a verified published correction while preserving the original review and version", async () => {
    const { t, reviewer, versionId, decisionId, args } = await setup();
    const before = await t.run(async ctx => ({ version: await ctx.db.get(versionId), decision: await ctx.db.get(decisionId) }));
    const id = await reviewer.client.mutation(recordCorrection, args);
    const after = await t.run(async ctx => ({ version: await ctx.db.get(versionId), decision: await ctx.db.get(decisionId),
      verification: await ctx.db.get(id as Id<"documentSourceVerifications">), audits: await ctx.db.query("auditEvents").withIndex("by_action_and_createdAt", q => q.eq("action", "document.source_correction")).take(3) }));
    expect(after.version).toEqual(before.version); expect(after.decision).toEqual(before.decision);
    expect(after.verification).toMatchObject({ ...reproduction, reviewerId: reviewer.userId, kind: "correction", assessment: "verified" });
    expect(after.audits).toHaveLength(1);
    expect(JSON.stringify(after.audits)).not.toContain(actualUrl);
  });
  it("replays an identical request once and rejects changed evidence using that key", async () => {
    const { t, reviewer, args } = await setup();
    const first = await reviewer.client.mutation(recordCorrection, args);
    expect(await reviewer.client.mutation(recordCorrection, args)).toBe(first);
    expect(await reviewer.client.mutation(recordCorrection, { ...args, reason: `  ${args.reason}  ` })).toBe(first);
    await expect(reviewer.client.mutation(recordCorrection, { ...args, sourceVerification: { ...reproduction, verificationNotes: "Different review evidence requiring a fresh operation key." } })).rejects.toThrow("DOCUMENT_SOURCE_IDEMPOTENCY_CONFLICT");
    expect(await t.run(ctx => ctx.db.query("documentSourceVerifications").take(3))).toHaveLength(1);
  });
  it("chains successive corrections and keeps previous evidence unchanged", async () => {
    const { t, reviewer, args } = await setup();
    const first = await reviewer.client.mutation(recordCorrection, args);
    const original = await t.run(ctx => ctx.db.get(first as Id<"documentSourceVerifications">));
    const second = await reviewer.client.mutation(recordCorrection, { ...args, idempotencyKey: "source-correction-2", sourceVerification: { ...reproduction, verificationNotes: "Additional court archive evidence supports this source assessment." } });
    expect(await t.run(ctx => ctx.db.get(second as Id<"documentSourceVerifications">))).toMatchObject({ previousVerificationId: first });
    expect(await t.run(ctx => ctx.db.get(first as Id<"documentSourceVerifications">))).toEqual(original);
    expect((await reviewer.client.query(listHistory, { versionId: args.versionId })).map((row: { _id: string }) => row._id)).toEqual([second, first]);
  });
  it("requires unpublication before an unresolved published correction and blocks in-flight or superseded originals", async () => {
    const { t, reviewer, args } = await setup();
    const unresolved = { ...args, assessment: "unresolved" as const, sourceVerification: { ...reproduction, completeOriginal: false, corroboratingUrls: [] } };
    for (const status of ["published", "publishing", "superseded"] as const) {
      await t.run(ctx => ctx.db.patch(args.versionId, { status }));
      await expect(reviewer.client.mutation(recordCorrection, unresolved)).rejects.toThrow(UNRESOLVED_SOURCE_GUIDANCE);
    }
    expect(await t.run(ctx => ctx.db.query("documentSourceVerifications").take(1))).toHaveLength(0);
  });
  it("invalidates an unresolved approved version and requires fresh verified approval before publication", async () => {
    const { t, reviewer, args, decisionId } = await setup("approved");
    const originalDecision = await t.run(ctx => ctx.db.get(decisionId));
    const unresolved = { ...args, assessment: "unresolved" as const, sourceVerification: { ...reproduction, completeOriginal: false, corroboratingUrls: [] } };
    const id = await reviewer.client.mutation(recordCorrection, unresolved);
    expect(await t.run(ctx => ctx.db.get(args.versionId))).toMatchObject({ status: "ready_for_review" });
    expect(await t.run(ctx => ctx.db.get(decisionId))).toEqual(originalDecision);
    expect(await reviewer.client.mutation(recordCorrection, unresolved)).toBe(id);
    const publication = { versionId: args.versionId, reason: "Publish after evidence review", idempotencyKey: "publish-source-test", confirmation: `PUBLISH ${args.versionId}` };
    await expect(reviewer.client.mutation(publishVersion, publication)).rejects.toThrow("DOCUMENT_TRANSITION_INVALID");
    await t.run(ctx => ctx.db.patch(args.versionId, { status: "approved" }));
    await expect(reviewer.client.mutation(publishVersion, publication)).rejects.toThrow("DOCUMENT_SOURCE_VERIFICATION_REQUIRED");
    // Replaying an old correction must not invalidate a subsequent approval again.
    expect(await reviewer.client.mutation(recordCorrection, unresolved)).toBe(id);
    expect(await t.run(ctx => ctx.db.get(args.versionId))).toMatchObject({ status: "approved" });
    expect(await t.run(ctx => ctx.db.query("auditEvents").withIndex("by_action_and_createdAt", q => q.eq("action", "document.source_approval_invalidated")).take(2))).toHaveLength(1);
  });
  it("records unresolved evidence only in inactive review states without changing lifecycle", async () => {
    const { t, reviewer, args } = await setup("unpublished");
    for (const status of ["unpublished", "rejected", "ready_for_review"] as const) {
      await t.run(ctx => ctx.db.patch(args.versionId, { status }));
      const id = await reviewer.client.mutation(recordCorrection, { ...args, assessment: "unresolved", idempotencyKey: `unresolved-${status}`, sourceVerification: { ...reproduction, completeOriginal: false, citationChecked: false, laterTreatmentChecked: false, corroboratingUrls: [] } });
      expect(await t.run(ctx => ctx.db.get(id as Id<"documentSourceVerifications">))).toMatchObject({ assessment: "unresolved", completeOriginal: false });
      expect(await t.run(ctx => ctx.db.get(args.versionId))).toMatchObject({ status });
    }
  });
  it("rejects insufficient verified evidence and forbids correction without assured reviewer access", async () => {
    const { t, reviewer, args } = await setup();
    await expect(reviewer.client.mutation(recordCorrection, { ...args, sourceVerification: { ...reproduction, citationChecked: false } })).rejects.toThrow("DOCUMENT_SOURCE_CHECKS_INCOMPLETE");
    const manager = await admin(t, "content_manager");
    await expect(manager.client.mutation(recordCorrection, args)).rejects.toThrow("ADMIN_FORBIDDEN");
    const unassured = await admin(t, "content_reviewer", false);
    await expect(unassured.client.mutation(recordCorrection, args)).rejects.toThrow();
    await expect(t.mutation(recordCorrection, args)).rejects.toThrow();
    process.env.ADMIN_PANEL_ENABLED = "false";
    await expect(reviewer.client.mutation(recordCorrection, args)).rejects.toThrow("ADMIN_DISABLED");
  });
  it("keeps approval evidence verified and leaves approval lifecycle enforcement to the existing caller", async () => {
    const { t, reviewer, args } = await setup("ready_for_review");
    const actor = { userId: reviewer.userId, roles: ["content_reviewer"] as const };
    const id = await t.run(ctx => recordSourceVerificationForActor(ctx, { ...actor, roles: [...actor.roles] }, { ...args, kind: "approval" }));
    expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ kind: "approval", assessment: "verified" });
    expect(await t.run(ctx => ctx.db.get(args.versionId))).toMatchObject({ status: "ready_for_review" });
    await expect(t.run(ctx => recordSourceVerificationForActor(ctx, { ...actor, roles: [...actor.roles] }, { ...args, idempotencyKey: "unresolved-approval", kind: "approval", assessment: "unresolved" }))).rejects.toThrow("DOCUMENT_SOURCE_APPROVAL_REQUIRES_VERIFICATION");
  });
});
