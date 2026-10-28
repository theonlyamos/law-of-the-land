/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import authSchema from "./betterAuth/schema";
import schema from "./schema";
import polarSchema from "../node_modules/@convex-dev/polar/src/component/schema";

const modules = import.meta.glob("./**/*.ts");
const authModules = Object.fromEntries(Object.entries(import.meta.glob("./betterAuth/**/*.ts")).map(([path, load]) => [`./${path.slice("./betterAuth/".length)}`, load]));
const polarModules = Object.fromEntries(Object.entries(import.meta.glob("../node_modules/@convex-dev/polar/src/component/**/*.ts"))
  .map(([path, load]) => [`./${path.slice("../node_modules/@convex-dev/polar/src/component/".length)}`, load]));
type Backend = TestConvex<typeof schema>;
type Client = ReturnType<Backend["withIdentity"]>;

const prepare = makeFunctionReference<"mutation">("chatAttachments:prepareUpload");
const finalize = makeFunctionReference<"mutation">("chatAttachments:finalizeUpload");
const saveReading = makeFunctionReference<"mutation">("documentReviews:saveReading");
const saveFindings = makeFunctionReference<"mutation">("documentReviews:saveFindings");
const complete = makeFunctionReference<"mutation">("documentReviews:complete");
const fail = makeFunctionReference<"mutation">("documentReviews:fail");
const deleteBatch = makeFunctionReference<"mutation">("documentReviews:deleteForSessionBatch");
const checkingInput = makeFunctionReference<"query">("documentReviews:checkingInput");

function backend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  t.registerComponent("polar", polarSchema, polarModules);
  return t;
}

async function user(t: Backend) {
  const identity = await t.run(async (ctx) => {
    const now = Date.now();
    const account = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: {
      name: "Review owner", email: `${crypto.randomUUID()}@example.com`, emailVerified: true, createdAt: now, updatedAt: now,
      role: "user", banned: false, twoFactorEnabled: false,
    } } });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "session", data: {
      token: crypto.randomUUID(), userId: account._id, expiresAt: now + 7 * 86_400_000, createdAt: now, updatedAt: now,
    } } });
    return { subject: account._id, sessionId: session._id };
  });
  return { client: t.withIdentity(identity), userId: identity.subject };
}

async function fixture() {
  const t = backend();
  const owner = await user(t);
  const jurisdictionId = await t.run(async (ctx) => {
    const now = Date.now();
    const id = await ctx.db.insert("jurisdictions", {
      name: "Ghana", slug: crypto.randomUUID(), status: "enabled", kind: "geographic", visibility: "public", isDefault: false,
      providerSyncState: "pending", createdAt: now, updatedAt: now, createdBy: "fixture", updatedBy: "fixture",
    });
    await ctx.db.insert("geographicJurisdictions", {
      jurisdictionId: id, googlePlaceId: crypto.randomUUID(), level: "country", latitude: 0, longitude: 0, formattedAddress: "Ghana",
      createdAt: now, updatedAt: now,
    });
    return id;
  });
  const externalId = crypto.randomUUID();
  await owner.client.mutation(api.chats.ensure, { externalId, jurisdictionId });
  const sessionId = await t.run(async (ctx) => (await ctx.db.query("chatSessions")
    .withIndex("by_user_externalId", (q) => q.eq("userId", owner.userId).eq("externalId", externalId)).unique())!._id);
  return { t, ...owner, jurisdictionId, externalId, sessionId };
}

async function upload(t: Backend, client: Client, externalId: string, content = "1. Rent is due on the first day.\n2. The landlord may enter at any time.", filename = "lease.txt") {
  const bytes = new TextEncoder().encode(content);
  const { attachmentId } = await client.mutation(prepare, { externalId, filename, mimeType: "text/plain", byteSize: bytes.length });
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob([bytes], { type: "text/plain" })));
  await client.mutation(finalize, { attachmentId, storageId, mimeType: "text/plain", kind: "text", extractedText: content });
  return attachmentId as Id<"chatAttachments">;
}

async function sendForReview(f: Awaited<ReturnType<typeof fixture>>, clientId = "user-1", question = "Can you check this lease before I sign?") {
  const attachmentId = await upload(f.t, f.client, f.externalId);
  await f.client.mutation(api.chats.appendMessages, {
    externalId: f.externalId, lastMessage: question,
    messages: [{ role: "user" as const, content: question, clientId, createdAt: 100, attachmentIds: [attachmentId] }],
  });
  const { reviewId } = await f.client.mutation(api.documentReviews.create, { externalId: f.externalId, userClientId: clientId, attachmentId, question });
  return { attachmentId, reviewId };
}

const READING = {
  documentType: "Tenancy agreement",
  title: "Residential lease",
  summary: "A one-year lease for a flat.",
  parties: [{ role: "Landlord", name: "A. Mensah" }, { role: "Tenant" }],
  roleOptions: [{ id: "tenant", label: "I'm the tenant" }, { id: "landlord", label: "I'm the landlord" }],
  focusOptions: [{ id: "rent", label: "Rent" }, { id: "entry", label: "Landlord entry" }],
  suggestedRoleId: "tenant",
  suggestedFocusIds: ["entry"],
  userGoal: "Check the lease before signing.",
  scope: "full" as const,
  isLegalDocument: true,
  segments: [
    { ref: "1", text: "Rent is due on the first day.", excerpt: false, priority: "key" as const, topics: ["rent"] },
    { ref: "2", text: "The landlord may enter at any time.", excerpt: false, priority: "key" as const, topics: ["entry"] },
    { ref: "3", text: "This agreement is governed by the laws of Ghana.", excerpt: false, priority: "boilerplate" as const, topics: [] },
  ],
};

async function startChecking(t: Backend, reviewId: Id<"documentReviews">, ordinals = [0, 1]) {
  // Stands in for `start`, which needs a ready research library.
  await t.run(async (ctx) => {
    const segments = await ctx.db.query("documentReviewSegments").withIndex("by_reviewId_and_ordinal", (q) => q.eq("reviewId", reviewId)).take(10);
    for (const segment of segments) await ctx.db.patch(segment._id, { checked: ordinals.includes(segment.ordinal) });
    await ctx.db.insert("documentReviewResearch", { reviewId, attempt: 1, research: { authorizedScopeSize: 1, partialCoverage: true, stores: [] } });
    await ctx.db.patch(reviewId, {
      status: "checking", roleId: "tenant", roleLabel: "I'm the tenant", focusIds: ["entry"], focusLabels: ["Landlord entry"],
      checkedCount: 0, checkTotal: ordinals.length, startRequested: false,
    });
  });
}

function finding(overrides: Record<string, unknown> = {}) {
  return {
    segmentOrdinal: 1, kind: "passage" as const, status: "attention" as const, title: "Entry without notice",
    meaning: "The landlord could come in whenever they like.", lawSummary: "The law requires reasonable notice.",
    recommendation: "Ask for 24 hours' written notice.", suggestedWording: "The landlord may enter with 24 hours' written notice.",
    provisions: ["s. 25"], citations: [], ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CONVEX_CLOUD_URL", undefined);
  vi.stubEnv("CONVEX_SITE_URL", undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("document reviews", () => {
  it("starts a review only for a file sent with a saved question, once per message and file", async () => {
    const f = await fixture();
    const unsent = await upload(f.t, f.client, f.externalId, "Draft", "draft.txt");
    await expect(f.client.mutation(api.documentReviews.create, { externalId: f.externalId, userClientId: "user-0", attachmentId: unsent, question: "Review this" }))
      .rejects.toThrow("DOCUMENT_REVIEW_UNAVAILABLE");

    const { attachmentId, reviewId } = await sendForReview(f);
    const again = await f.client.mutation(api.documentReviews.create, { externalId: f.externalId, userClientId: "user-1", attachmentId, question: "Again" });
    expect(again.reviewId).toBe(reviewId);

    const list = await f.client.query(api.documentReviews.listForChat, { externalId: f.externalId });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: reviewId, userClientId: "user-1", filename: "lease.txt", status: "reading", question: "Can you check this lease before I sign?", jurisdictionName: "Ghana" });
    // A review counts as one question, however many times it is requested.
    const usage = await f.t.run((ctx) => ctx.db.query("dailyUsage").take(5));
    expect(usage).toMatchObject([{ count: 1 }]);
  });

  it("keeps reviews private to their owner", async () => {
    const f = await fixture();
    const { reviewId } = await sendForReview(f);
    const other = await user(f.t);
    await expect(other.client.query(api.documentReviews.get, { reviewId })).resolves.toBeNull();
    await expect(other.client.query(api.documentReviews.listForChat, { externalId: f.externalId })).resolves.toEqual([]);
    await expect(other.client.mutation(api.documentReviews.cancel, { reviewId })).rejects.toThrow("DOCUMENT_REVIEW_UNAVAILABLE");
  });

  it("asks the setup questions once the document has been read", async () => {
    const f = await fixture();
    const { reviewId } = await sendForReview(f);
    await f.t.mutation(saveReading, { reviewId, attempt: 1, reading: READING });
    const [summary] = await f.client.query(api.documentReviews.listForChat, { externalId: f.externalId });
    expect(summary).toMatchObject({
      status: "awaiting_input", documentType: "Tenancy agreement", segmentCount: 3, suggestedRoleId: "tenant", suggestedFocusIds: ["entry"],
      roleOptions: READING.roleOptions, focusOptions: READING.focusOptions, isLegalDocument: true,
    });
    // A stale reading for an older attempt is ignored.
    await f.t.mutation(saveReading, { reviewId, attempt: 0, reading: { ...READING, documentType: "Other" } });
    expect((await f.client.query(api.documentReviews.get, { reviewId }))?.review.documentType).toBe("Tenancy agreement");
  });

  it("does not start checking when the law library is unavailable, and rejects unknown choices", async () => {
    const f = await fixture();
    const { reviewId } = await sendForReview(f);
    await f.t.mutation(saveReading, { reviewId, attempt: 1, reading: READING });
    await expect(f.client.mutation(api.documentReviews.start, { reviewId, roleId: "buyer", focusIds: [] })).rejects.toThrow("DOCUMENT_REVIEW_INVALID_CHOICE");
    await expect(f.client.mutation(api.documentReviews.start, { reviewId, roleId: "tenant", focusIds: ["entry"] })).rejects.toThrow("DOCUMENT_REVIEW_RESEARCH_UNAVAILABLE");
    expect((await f.client.query(api.documentReviews.get, { reviewId }))?.review.status).toBe("awaiting_input");
  });

  it("downgrades conclusions without a valid source and completes with counts", async () => {
    const f = await fixture();
    const { reviewId } = await sendForReview(f);
    await f.t.mutation(saveReading, { reviewId, attempt: 1, reading: READING });
    await startChecking(f.t, reviewId);

    const input = await f.t.query(checkingInput, { reviewId, attempt: 1 });
    expect(input.passages.map((passage: { ordinal: number }) => passage.ordinal)).toEqual([0, 1]);
    expect(input.context).toMatchObject({ role: "I'm the tenant", focus: ["Landlord entry"], documentType: "Tenancy agreement" });

    await f.t.mutation(saveFindings, {
      reviewId, attempt: 1, checkedOrdinals: [0, 1], pool: [],
      findings: [
        finding(),
        finding({ segmentOrdinal: 0, status: "unconfirmed", title: "Rent due date", lawSummary: "The library doesn't cover rent due dates.", suggestedWording: undefined }),
        // Not one of the passages checked in this batch.
        finding({ segmentOrdinal: 2, title: "Governing law" }),
        // A missing term needs a confirmed source to be shown at all.
        finding({ segmentOrdinal: undefined, kind: "missing", title: "No deposit terms" }),
        finding({
          title: "Bogus citation", citations: [{ jurisdictionId: f.jurisdictionId, resourceId: "missing", versionId: "missing", providerStoreName: "fileSearchStores/none" }],
        }),
      ],
    });
    const progress = await f.client.query(api.documentReviews.listForChat, { externalId: f.externalId });
    expect(progress[0]).toMatchObject({ status: "checking", checkedCount: 2, checkTotal: 2 });

    await f.t.mutation(complete, { reviewId, attempt: 1, headline: "One part needs a closer look", overview: "Overview", nextSteps: ["Ask about entry"] });
    const review = await f.client.query(api.documentReviews.get, { reviewId });
    expect(review).not.toBeNull();
    expect(review!.review).toMatchObject({ status: "completed", headline: "One part needs a closer look", counts: { attention: 0, check: 0, fine: 0, unconfirmed: 2 } });
    expect(review!.partialCoverage).toBe(true);
    expect(review!.nextSteps).toEqual(["Ask about entry"]);
    expect(review!.segments).toHaveLength(3);
    expect(review!.findings).toHaveLength(2);
    const entry = review!.findings.find((item) => item.segmentOrdinal === 1)!;
    expect(entry).toMatchObject({ status: "unconfirmed", citations: [], lawSummary: "No provision in the library could be linked to this part, so there is no law to cite for it." });
    const rent = review!.findings.find((item) => item.segmentOrdinal === 0)!;
    expect(rent).toMatchObject({ status: "unconfirmed", lawSummary: "The library doesn't cover rent due dates." });
    expect(review!.review.preview.map((item) => item.ref)).toEqual(["1", "2"]);
  });

  it("discards work from a stopped attempt and resumes from the right step on retry", async () => {
    const f = await fixture();
    const { reviewId } = await sendForReview(f);
    await f.t.mutation(saveReading, { reviewId, attempt: 1, reading: READING });
    await startChecking(f.t, reviewId);
    await f.client.mutation(api.documentReviews.cancel, { reviewId });
    await f.t.mutation(saveFindings, { reviewId, attempt: 1, checkedOrdinals: [1], pool: [], findings: [finding()] });
    let review = await f.client.query(api.documentReviews.get, { reviewId });
    expect(review!.review).toMatchObject({ status: "cancelled", failure: "cancelled" });
    expect(review!.findings).toEqual([]);

    // Choices were made, so a retry needs the library again before checking.
    await expect(f.client.mutation(api.documentReviews.retry, { reviewId })).rejects.toThrow("DOCUMENT_REVIEW_RESEARCH_UNAVAILABLE");

    await f.t.run(async (ctx) => { await ctx.db.patch(reviewId, { roleId: undefined, roleLabel: undefined }); });
    await f.client.mutation(api.documentReviews.retry, { reviewId });
    review = await f.client.query(api.documentReviews.get, { reviewId });
    expect(review!.review).toMatchObject({ status: "awaiting_input", checkedCount: 0 });
    expect(review!.review.failure).toBeUndefined();
  });

  it("never lets findings from an earlier attempt hide or block the current ones", async () => {
    const f = await fixture();
    const { reviewId } = await sendForReview(f);
    await f.t.mutation(saveReading, { reviewId, attempt: 1, reading: READING });
    await startChecking(f.t, reviewId);
    await f.t.run(async (ctx) => {
      for (let ordinal = 0; ordinal < 70; ordinal += 1) {
        await ctx.db.insert("documentReviewFindings", {
          reviewId, attempt: 1, ordinal, segmentOrdinal: 1, kind: "passage", status: "attention", title: `Old ${ordinal}`,
          meaning: "Old", lawSummary: "Old", recommendation: "Old", citations: [],
        });
      }
      await ctx.db.patch(reviewId, { attempt: 2 });
    });
    await f.t.mutation(saveFindings, { reviewId, attempt: 2, checkedOrdinals: [1], pool: [], findings: [finding()] });
    const review = await f.client.query(api.documentReviews.get, { reviewId });
    expect(review!.findings.map((item) => item.title)).toEqual(["Entry without notice"]);
    expect(review!.review.checkedCount).toBe(1);

    // A retry clears what earlier attempts left behind.
    await f.t.mutation(fail, { reviewId, attempt: 2, failure: "timeout" });
    await f.t.run(async (ctx) => { await ctx.db.patch(reviewId, { roleId: undefined, roleLabel: undefined }); });
    await f.client.mutation(api.documentReviews.retry, { reviewId });
    expect(await f.t.run((ctx) => ctx.db.query("documentReviewFindings").take(200))).toEqual([]);
  });

  it("shows a failure and lets the person try again from reading", async () => {
    const f = await fixture();
    const { reviewId } = await sendForReview(f);
    await f.t.mutation(fail, { reviewId, attempt: 1, failure: "unreadable" });
    expect((await f.client.query(api.documentReviews.listForChat, { externalId: f.externalId }))[0]).toMatchObject({ status: "failed", failure: "unreadable" });
    await f.client.mutation(api.documentReviews.retry, { reviewId });
    expect((await f.client.query(api.documentReviews.listForChat, { externalId: f.externalId }))[0]).toMatchObject({ status: "reading" });
    expect(await f.t.run(async (ctx) => (await ctx.db.get(reviewId))?.attempt)).toBe(2);
  });

  it("deletes reviews and their parts with the chat", async () => {
    const f = await fixture();
    const { reviewId } = await sendForReview(f);
    await f.t.mutation(saveReading, { reviewId, attempt: 1, reading: READING });
    await startChecking(f.t, reviewId);
    await f.t.mutation(saveFindings, { reviewId, attempt: 1, checkedOrdinals: [1], pool: [], findings: [finding({ status: "unconfirmed" })] });
    for (let round = 0; round < 5; round += 1) {
      const { hasMore } = await f.t.mutation(deleteBatch, { sessionId: f.sessionId });
      if (!hasMore) break;
    }
    const left = await f.t.run(async (ctx) => ({
      reviews: await ctx.db.query("documentReviews").take(1),
      segments: await ctx.db.query("documentReviewSegments").take(1),
      findings: await ctx.db.query("documentReviewFindings").take(1),
      research: await ctx.db.query("documentReviewResearch").take(1),
    }));
    expect(left).toEqual({ reviews: [], segments: [], findings: [], research: [] });
  });
});
