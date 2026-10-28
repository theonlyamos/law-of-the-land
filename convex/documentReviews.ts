import { makeFunctionReference } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { optionalUserId, requireUserId } from "./lib/requireUser";
import { canAccessSession, validateGovernedCitations } from "./chats";
import { ownedAttachmentSession } from "./chatAttachments";
import { resolveChatResearchStoresForJurisdiction, type ChatResearchStore } from "./jurisdictions";
import { activeOrganizationIdsForUser } from "./lib/jurisdictionAccess";
import { recordQuestionForUser } from "./usage";
import { PUBLICATION_FILTER_PROTOCOL } from "../shared/gemini-publication-filter";
import {
  DEFAULT_REVIEW_QUESTION,
  DOCUMENT_REVIEW_LIMITS as LIMITS,
  NOT_SURE_ROLE,
  countFindings,
  sortFindings,
} from "../shared/document-review";
import {
  documentReviewCountsValidator,
  documentReviewFailureValidator,
  documentReviewOptionValidator,
  documentReviewStatusValidator,
  findingStatusValidator,
  proposedFindingValidator,
  publicFindingCitationValidator,
  readingResultValidator,
  researchSnapshotValidator,
} from "./lib/documentReviewContracts";
import { attachPooledCitations, selectSegmentsToCheck } from "./lib/documentReviewModel";

type ReviewCtx = QueryCtx | MutationCtx;
const readRef = makeFunctionReference<"action">("documentReviewActions:read");
const checkRef = makeFunctionReference<"action">("documentReviewActions:check");
const deleteBatchRef = makeFunctionReference<"mutation">("documentReviews:deleteForSessionBatch");
const DELETE_BATCH_SIZE = 50;

function unavailable(): never {
  throw new ConvexError("DOCUMENT_REVIEW_UNAVAILABLE");
}

async function ownedReview(ctx: ReviewCtx, reviewId: Id<"documentReviews">, userId: string): Promise<{ review: Doc<"documentReviews">; session: Doc<"chatSessions"> }> {
  const review = await ctx.db.get("documentReviews", reviewId);
  if (!review || review.userId !== userId) unavailable();
  const session = await ctx.db.get("chatSessions", review.sessionId);
  if (!session || session.userId !== userId || !(await canAccessSession(ctx, session))) unavailable();
  return { review, session };
}

const previewValidator = v.object({ ref: v.optional(v.string()), title: v.string(), status: findingStatusValidator });

const reviewSummaryValidator = v.object({
  id: v.id("documentReviews"),
  userClientId: v.string(),
  attachmentId: v.id("chatAttachments"),
  filename: v.string(),
  question: v.string(),
  status: documentReviewStatusValidator,
  documentType: v.optional(v.string()),
  title: v.optional(v.string()),
  summary: v.optional(v.string()),
  roleOptions: v.array(documentReviewOptionValidator),
  focusOptions: v.array(documentReviewOptionValidator),
  suggestedRoleId: v.optional(v.string()),
  suggestedFocusIds: v.array(v.string()),
  isLegalDocument: v.optional(v.boolean()),
  roleLabel: v.optional(v.string()),
  focusLabels: v.array(v.string()),
  startRequested: v.boolean(),
  segmentCount: v.number(),
  checkedCount: v.number(),
  checkTotal: v.number(),
  headline: v.optional(v.string()),
  counts: v.optional(documentReviewCountsValidator),
  preview: v.array(previewValidator),
  failure: v.optional(documentReviewFailureValidator),
  jurisdictionName: v.string(),
  createdAt: v.number(),
  completedAt: v.optional(v.number()),
});

async function currentFindings(ctx: ReviewCtx, review: Doc<"documentReviews">): Promise<Doc<"documentReviewFindings">[]> {
  return await ctx.db.query("documentReviewFindings")
    .withIndex("by_reviewId_and_attempt_and_ordinal", (q) => q.eq("reviewId", review._id).eq("attempt", review.attempt))
    .take(LIMITS.maxFindings + LIMITS.maxGapFindings);
}

async function segmentRefs(ctx: ReviewCtx, reviewId: Id<"documentReviews">): Promise<Map<number, string | undefined>> {
  const rows = await ctx.db.query("documentReviewSegments")
    .withIndex("by_reviewId_and_ordinal", (q) => q.eq("reviewId", reviewId))
    .take(LIMITS.maxSegments);
  return new Map(rows.map((row) => [row.ordinal, row.ref]));
}

async function summarize(ctx: ReviewCtx, review: Doc<"documentReviews">): Promise<Infer<typeof reviewSummaryValidator>> {
  let preview: Infer<typeof previewValidator>[] = [];
  if (review.status === "checking" || review.status === "completed") {
    const findings = await currentFindings(ctx, review);
    const refs = await segmentRefs(ctx, review._id);
    // While checking, show the latest results; once complete, the most serious first.
    const chosen = review.status === "checking" ? findings.slice(-6) : sortFindings(findings).slice(0, 3);
    preview = chosen.map((finding) => {
      const ref = finding.segmentOrdinal === undefined ? undefined : refs.get(finding.segmentOrdinal);
      return { ...(ref ? { ref } : {}), title: finding.title, status: finding.status };
    });
  }
  return {
    id: review._id,
    userClientId: review.userClientId,
    attachmentId: review.attachmentId,
    filename: review.filename,
    question: review.question,
    status: review.status,
    ...(review.documentType ? { documentType: review.documentType } : {}),
    ...(review.title ? { title: review.title } : {}),
    ...(review.summary ? { summary: review.summary } : {}),
    roleOptions: review.roleOptions ?? [],
    focusOptions: review.focusOptions ?? [],
    ...(review.suggestedRoleId ? { suggestedRoleId: review.suggestedRoleId } : {}),
    suggestedFocusIds: review.suggestedFocusIds ?? [],
    ...(review.isLegalDocument === undefined ? {} : { isLegalDocument: review.isLegalDocument }),
    ...(review.roleLabel ? { roleLabel: review.roleLabel } : {}),
    focusLabels: review.focusLabels ?? [],
    startRequested: review.startRequested === true,
    segmentCount: review.segmentCount ?? 0,
    checkedCount: review.checkedCount ?? 0,
    checkTotal: review.checkTotal ?? 0,
    ...(review.headline ? { headline: review.headline } : {}),
    ...(review.counts ? { counts: review.counts } : {}),
    preview,
    ...(review.failure ? { failure: review.failure } : {}),
    jurisdictionName: review.jurisdictionName,
    createdAt: review.createdAt,
    ...(review.completedAt === undefined ? {} : { completedAt: review.completedAt }),
  };
}

/** Reviews in one chat, oldest first, for showing beside the messages that asked for them. */
export const listForChat = query({
  args: { externalId: v.string() },
  returns: v.array(reviewSummaryValidator),
  handler: async (ctx, args) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return [];
    const session = await ctx.db.query("chatSessions")
      .withIndex("by_user_externalId", (q) => q.eq("userId", userId).eq("externalId", args.externalId))
      .unique();
    if (!session || !(await canAccessSession(ctx, session))) return [];
    const reviews = await ctx.db.query("documentReviews")
      .withIndex("by_sessionId_and_createdAt", (q) => q.eq("sessionId", session._id))
      .take(LIMITS.maxReviewsPerChat);
    return await Promise.all(reviews.map((review) => summarize(ctx, review)));
  },
});

const segmentValidator = v.object({
  ordinal: v.number(),
  ref: v.optional(v.string()),
  heading: v.optional(v.string()),
  text: v.string(),
  page: v.optional(v.number()),
  excerpt: v.boolean(),
  checked: v.boolean(),
});

const findingValidator = v.object({
  id: v.id("documentReviewFindings"),
  ordinal: v.number(),
  segmentOrdinal: v.optional(v.number()),
  kind: v.union(v.literal("passage"), v.literal("missing")),
  status: findingStatusValidator,
  title: v.string(),
  meaning: v.string(),
  lawSummary: v.string(),
  recommendation: v.string(),
  suggestedWording: v.optional(v.string()),
  citations: v.array(publicFindingCitationValidator),
});

/** Everything the side-by-side review needs. */
export const get = query({
  args: { reviewId: v.id("documentReviews") },
  returns: v.union(v.null(), v.object({
    review: reviewSummaryValidator,
    overview: v.optional(v.string()),
    nextSteps: v.array(v.string()),
    parties: v.array(v.object({ role: v.string(), name: v.optional(v.string()) })),
    partialCoverage: v.boolean(),
    segments: v.array(segmentValidator),
    findings: v.array(findingValidator),
  })),
  handler: async (ctx, args) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return null;
    let owned: Awaited<ReturnType<typeof ownedReview>>;
    try { owned = await ownedReview(ctx, args.reviewId, userId); } catch { return null; }
    const { review } = owned;
    const [segments, findings] = await Promise.all([
      ctx.db.query("documentReviewSegments")
        .withIndex("by_reviewId_and_ordinal", (q) => q.eq("reviewId", review._id))
        .take(LIMITS.maxSegments),
      currentFindings(ctx, review),
    ]);
    // A source opens only when its original is a published PDF; this is rechecked on open.
    const previewable = new Map<string, Promise<boolean>>();
    const canPreview = (versionId: Id<"documentVersions">, resourceId: Id<"legalResources">) => {
      const key = `${resourceId}:${versionId}`;
      let pending = previewable.get(key);
      if (!pending) {
        pending = Promise.all([ctx.db.get("documentVersions", versionId), ctx.db.get("legalResources", resourceId)])
          .then(([version, resource]) => version?.mimeType === "application/pdf" && resource?.catalogPublished === true);
        previewable.set(key, pending);
      }
      return pending;
    };
    return {
      review: await summarize(ctx, review),
      ...(review.overview ? { overview: review.overview } : {}),
      nextSteps: review.nextSteps ?? [],
      parties: review.parties ?? [],
      partialCoverage: review.partialCoverage === true,
      segments: segments.map((segment) => ({
        ordinal: segment.ordinal,
        ...(segment.ref ? { ref: segment.ref } : {}),
        ...(segment.heading ? { heading: segment.heading } : {}),
        text: segment.text,
        ...(segment.page ? { page: segment.page } : {}),
        excerpt: segment.excerpt,
        checked: segment.checked,
      })),
      findings: await Promise.all(findings.map(async (finding) => ({
        id: finding._id,
        ordinal: finding.ordinal,
        ...(finding.segmentOrdinal === undefined ? {} : { segmentOrdinal: finding.segmentOrdinal }),
        kind: finding.kind,
        status: finding.status,
        title: finding.title,
        meaning: finding.meaning,
        lawSummary: finding.lawSummary,
        recommendation: finding.recommendation,
        ...(finding.suggestedWording ? { suggestedWording: finding.suggestedWording } : {}),
        citations: await Promise.all(finding.citations.map(async (citation) => ({
          label: citation.label,
          ...(citation.provision ? { provision: citation.provision } : {}),
          jurisdictionName: citation.jurisdictionName,
          jurisdictionKind: citation.jurisdictionKind,
          relation: citation.relation,
          ...(citation.pageNumber === undefined ? {} : { pageNumber: citation.pageNumber }),
          previewable: await canPreview(citation.versionId, citation.resourceId),
        }))),
      }))),
    };
  },
});

/**
 * Starts reading one attached document for review. The question and its file
 * must already be saved as a user message in this chat.
 */
export const create = mutation({
  args: { externalId: v.string(), userClientId: v.string(), attachmentId: v.id("chatAttachments"), question: v.string() },
  returns: v.object({ reviewId: v.id("documentReviews") }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const session = await ownedAttachmentSession(ctx, args.externalId);
    if (!session.jurisdictionId || !session.jurisdictionName) unavailable();
    if (!args.userClientId.trim() || args.userClientId.length > 200) unavailable();
    const attachment = await ctx.db.get("chatAttachments", args.attachmentId);
    if (!attachment || attachment.sessionId !== session._id || attachment.userId !== userId || attachment.status !== "ready"
      || !attachment.storageId || attachment.messageClientId !== args.userClientId) unavailable();
    const message = await ctx.db.query("messages")
      .withIndex("by_session_clientId", (q) => q.eq("sessionId", session._id).eq("clientId", args.userClientId))
      .unique();
    if (!message || message.role !== "user") unavailable();

    const existing = await ctx.db.query("documentReviews")
      .withIndex("by_sessionId_and_userClientId", (q) => q.eq("sessionId", session._id).eq("userClientId", args.userClientId))
      .take(LIMITS.maxReviewsPerChat);
    const sameFile = existing.find((review) => review.attachmentId === args.attachmentId);
    if (sameFile) return { reviewId: sameFile._id };
    const inChat = await ctx.db.query("documentReviews")
      .withIndex("by_sessionId_and_createdAt", (q) => q.eq("sessionId", session._id))
      .take(LIMITS.maxReviewsPerChat);
    if (inChat.length >= LIMITS.maxReviewsPerChat) throw new ConvexError("DOCUMENT_REVIEW_LIMIT");

    await recordQuestionForUser(ctx, userId);
    const now = Date.now();
    const question = args.question.trim().slice(0, LIMITS.maxQuestionCharacters) || DEFAULT_REVIEW_QUESTION;
    const reviewId = await ctx.db.insert("documentReviews", {
      sessionId: session._id,
      userId,
      userClientId: args.userClientId,
      attachmentId: attachment._id,
      filename: attachment.filename,
      question,
      status: "reading",
      attempt: 1,
      jurisdictionName: session.jurisdictionName,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, readRef, { reviewId, attempt: 1 });
    return { reviewId };
  },
});

function chosenRole(review: Doc<"documentReviews">, roleId: string | undefined): { roleId: string; roleLabel: string } {
  if (roleId === undefined || roleId === NOT_SURE_ROLE.id) return { roleId: NOT_SURE_ROLE.id, roleLabel: NOT_SURE_ROLE.label };
  const option = review.roleOptions?.find((entry) => entry.id === roleId);
  if (!option) throw new ConvexError("DOCUMENT_REVIEW_INVALID_CHOICE");
  return { roleId: option.id, roleLabel: option.label };
}

function chosenFocus(review: Doc<"documentReviews">, focusIds: readonly string[]): { focusIds: string[]; focusLabels: string[] } {
  if (focusIds.length > LIMITS.maxSelectedFocus || new Set(focusIds).size !== focusIds.length) throw new ConvexError("DOCUMENT_REVIEW_INVALID_CHOICE");
  const options = new Map((review.focusOptions ?? []).map((option) => [option.id, option.label]));
  if (focusIds.some((id) => !options.has(id))) throw new ConvexError("DOCUMENT_REVIEW_INVALID_CHOICE");
  return { focusIds: [...focusIds], focusLabels: focusIds.map((id) => options.get(id)!) };
}

/**
 * Captures the research scope with the person's own access, before any
 * background step runs without it. Throws when the library is unavailable.
 */
async function captureResearch(ctx: MutationCtx, review: Doc<"documentReviews">, session: Doc<"chatSessions">, attempt: number) {
  let research: Infer<typeof researchSnapshotValidator>;
  try {
    research = await resolveChatResearchStoresForJurisdiction(ctx, session.jurisdictionId!, PUBLICATION_FILTER_PROTOCOL);
  } catch {
    throw new ConvexError("DOCUMENT_REVIEW_RESEARCH_UNAVAILABLE");
  }
  const existing = await ctx.db.query("documentReviewResearch").withIndex("by_reviewId", (q) => q.eq("reviewId", review._id)).unique();
  if (existing) await ctx.db.replace("documentReviewResearch", existing._id, { reviewId: review._id, attempt, research });
  else await ctx.db.insert("documentReviewResearch", { reviewId: review._id, attempt, research });
}

async function researchSnapshot(ctx: ReviewCtx, reviewId: Id<"documentReviews">) {
  return (await ctx.db.query("documentReviewResearch").withIndex("by_reviewId", (q) => q.eq("reviewId", reviewId)).unique())?.research ?? null;
}

async function beginChecking(ctx: MutationCtx, review: Doc<"documentReviews">, choices: { roleId: string; roleLabel: string; focusIds: string[]; focusLabels: string[] }) {
  const segments = await ctx.db.query("documentReviewSegments")
    .withIndex("by_reviewId_and_ordinal", (q) => q.eq("reviewId", review._id))
    .take(LIMITS.maxSegments);
  const selected = new Set(selectSegmentsToCheck(segments, { focusIds: choices.focusIds, scope: review.scope ?? "full" }));
  for (const segment of segments) {
    const checked = selected.has(segment.ordinal);
    if (segment.checked !== checked) await ctx.db.patch("documentReviewSegments", segment._id, { checked });
  }
  await ctx.db.patch("documentReviews", review._id, {
    ...choices,
    status: "checking",
    startRequested: false,
    checkedCount: 0,
    checkTotal: selected.size,
    updatedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, checkRef, { reviewId: review._id, attempt: review.attempt });
}

/** Records the person's side and focus, and starts checking (or queues the start while reading finishes). */
export const start = mutation({
  args: { reviewId: v.id("documentReviews"), roleId: v.optional(v.string()), focusIds: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const { review, session } = await ownedReview(ctx, args.reviewId, userId);
    if (review.status !== "reading" && review.status !== "awaiting_input") throw new ConvexError("DOCUMENT_REVIEW_NOT_READY");
    const choices = review.status === "awaiting_input" ? { ...chosenRole(review, args.roleId), ...chosenFocus(review, args.focusIds) } : null;
    await captureResearch(ctx, review, session, review.attempt);
    if (!choices) {
      // Options are not known yet; keep the request and apply suggestions once reading finishes.
      await ctx.db.patch("documentReviews", review._id, { startRequested: true, updatedAt: Date.now() });
      return null;
    }
    await beginChecking(ctx, review, choices);
    return null;
  },
});

export const cancel = mutation({
  args: { reviewId: v.id("documentReviews") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const { review } = await ownedReview(ctx, args.reviewId, userId);
    if (review.status !== "reading" && review.status !== "checking" && review.status !== "awaiting_input") return null;
    // Bumping the attempt makes any running step discard its results.
    await ctx.db.patch("documentReviews", review._id, {
      status: "cancelled", failure: "cancelled", attempt: review.attempt + 1, startRequested: false, updatedAt: Date.now(),
    });
    return null;
  },
});

/** Runs a failed or stopped review again from the step it needs. */
export const retry = mutation({
  args: { reviewId: v.id("documentReviews") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const { review, session } = await ownedReview(ctx, args.reviewId, userId);
    if (review.status !== "failed" && review.status !== "cancelled") throw new ConvexError("DOCUMENT_REVIEW_NOT_RETRYABLE");
    const attempt = review.attempt + 1;
    const hasReading = (review.segmentCount ?? 0) > 0;
    const hasChoices = review.roleId !== undefined;
    if (hasReading && hasChoices) await captureResearch(ctx, review, session, attempt);
    // Earlier attempts' findings are never shown again.
    const stale = await ctx.db.query("documentReviewFindings")
      .withIndex("by_reviewId_and_attempt_and_ordinal", (q) => q.eq("reviewId", review._id).lt("attempt", attempt))
      .take(2 * (LIMITS.maxFindings + LIMITS.maxGapFindings));
    for (const row of stale) await ctx.db.delete("documentReviewFindings", row._id);
    await ctx.db.patch("documentReviews", review._id, {
      attempt, failure: undefined, headline: undefined, overview: undefined, nextSteps: undefined, counts: undefined,
      completedAt: undefined, checkedCount: 0, updatedAt: Date.now(),
      status: !hasReading ? "reading" : hasChoices ? "checking" : "awaiting_input",
    });
    if (!hasReading) await ctx.scheduler.runAfter(0, readRef, { reviewId: review._id, attempt });
    else if (hasChoices) await ctx.scheduler.runAfter(0, checkRef, { reviewId: review._id, attempt });
    return null;
  },
});

// ------------------------------------------------------------ internal steps

async function activeReview(ctx: ReviewCtx, reviewId: Id<"documentReviews">, attempt: number, status: Doc<"documentReviews">["status"]) {
  const review = await ctx.db.get("documentReviews", reviewId);
  if (!review || review.attempt !== attempt || review.status !== status) return null;
  const session = await ctx.db.get("chatSessions", review.sessionId);
  if (!session || session.userId !== review.userId) return null;
  // Background steps have no signed-in user, so access is checked for the review's owner.
  let memberships: Set<Id<"organizations">> | null;
  try { memberships = await activeOrganizationIdsForUser(ctx, review.userId); } catch { memberships = null; }
  if (!(await canAccessSession(ctx, session, memberships))) return null;
  return { review, session };
}

export const readingInput = internalQuery({
  args: { reviewId: v.id("documentReviews"), attempt: v.number() },
  returns: v.union(v.null(), v.object({
    storageId: v.id("_storage"),
    filename: v.string(),
    mimeType: v.string(),
    kind: v.union(v.literal("document"), v.literal("text"), v.literal("image")),
    byteSize: v.number(),
    extractedText: v.optional(v.string()),
    question: v.string(),
    jurisdictionName: v.string(),
  })),
  handler: async (ctx, args) => {
    const active = await activeReview(ctx, args.reviewId, args.attempt, "reading");
    if (!active) return null;
    const attachment = await ctx.db.get("chatAttachments", active.review.attachmentId);
    if (!attachment || attachment.sessionId !== active.session._id || attachment.status !== "ready" || !attachment.storageId) return null;
    return {
      storageId: attachment.storageId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      kind: attachment.kind,
      byteSize: attachment.byteSize,
      ...(attachment.extractedText === undefined ? {} : { extractedText: attachment.extractedText }),
      question: active.review.question,
      jurisdictionName: active.review.jurisdictionName,
    };
  },
});

export const saveReading = internalMutation({
  args: { reviewId: v.id("documentReviews"), attempt: v.number(), reading: readingResultValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const active = await activeReview(ctx, args.reviewId, args.attempt, "reading");
    if (!active) return null;
    const { review } = active;
    const { reading } = args;
    // Retries replace an earlier reading.
    const previous = await ctx.db.query("documentReviewSegments")
      .withIndex("by_reviewId_and_ordinal", (q) => q.eq("reviewId", review._id))
      .take(LIMITS.maxSegments + 1);
    for (const row of previous) await ctx.db.delete("documentReviewSegments", row._id);
    const segments = reading.segments.slice(0, LIMITS.maxSegments);
    for (const [ordinal, segment] of segments.entries()) {
      await ctx.db.insert("documentReviewSegments", { reviewId: review._id, ordinal, ...segment, checked: false });
    }
    await ctx.db.patch("documentReviews", review._id, {
      status: "awaiting_input",
      documentType: reading.documentType,
      title: reading.title,
      summary: reading.summary,
      parties: reading.parties,
      roleOptions: reading.roleOptions.slice(0, LIMITS.maxRoleOptions),
      focusOptions: reading.focusOptions.slice(0, LIMITS.maxFocusOptions),
      ...(reading.suggestedRoleId ? { suggestedRoleId: reading.suggestedRoleId } : {}),
      suggestedFocusIds: reading.suggestedFocusIds,
      userGoal: reading.userGoal,
      scope: reading.scope,
      isLegalDocument: reading.isLegalDocument,
      segmentCount: segments.length,
      updatedAt: Date.now(),
    });
    if (review.startRequested) {
      const updated = (await ctx.db.get("documentReviews", review._id))!;
      await beginChecking(ctx, updated, {
        ...chosenRole(updated, updated.suggestedRoleId),
        ...chosenFocus(updated, updated.suggestedFocusIds ?? []),
      });
    }
    return null;
  },
});

export const checkingInput = internalQuery({
  args: { reviewId: v.id("documentReviews"), attempt: v.number() },
  returns: v.union(v.null(), v.object({
    context: v.object({
      jurisdictionName: v.string(), question: v.string(), userGoal: v.string(), documentType: v.string(),
      documentTitle: v.string(), summary: v.string(), role: v.string(), focus: v.array(v.string()),
    }),
    passages: v.array(v.object({ ordinal: v.number(), ref: v.optional(v.string()), heading: v.optional(v.string()), text: v.string() })),
    outline: v.array(v.object({ ref: v.optional(v.string()), heading: v.optional(v.string()), topics: v.array(v.string()) })),
    research: v.union(v.null(), researchSnapshotValidator),
    alreadyChecked: v.array(v.number()),
  })),
  handler: async (ctx, args) => {
    const active = await activeReview(ctx, args.reviewId, args.attempt, "checking");
    if (!active) return null;
    const { review } = active;
    const segments = await ctx.db.query("documentReviewSegments")
      .withIndex("by_reviewId_and_ordinal", (q) => q.eq("reviewId", review._id))
      .take(LIMITS.maxSegments);
    const research = await researchSnapshot(ctx, review._id);
    const findings = await currentFindings(ctx, review);
    const focusLabels = new Map((review.focusOptions ?? []).map((option) => [option.id, option.label]));
    return {
      context: {
        jurisdictionName: review.jurisdictionName,
        question: review.question,
        userGoal: review.userGoal ?? review.question,
        documentType: review.documentType ?? "Document",
        documentTitle: review.title ?? review.filename,
        summary: review.summary ?? "",
        role: review.roleId === NOT_SURE_ROLE.id ? "Not stated" : review.roleLabel ?? "Not stated",
        focus: review.focusLabels ?? [],
      },
      passages: segments.filter((segment) => segment.checked).map((segment) => ({
        ordinal: segment.ordinal,
        ...(segment.ref ? { ref: segment.ref } : {}),
        ...(segment.heading ? { heading: segment.heading } : {}),
        text: segment.text,
      })),
      outline: segments.map((segment) => ({
        ...(segment.ref ? { ref: segment.ref } : {}),
        ...(segment.heading ? { heading: segment.heading } : {}),
        topics: segment.topics.map((topic) => focusLabels.get(topic) ?? topic),
      })),
      research,
      alreadyChecked: [...new Set(findings.flatMap((finding) => finding.segmentOrdinal === undefined ? [] : [finding.segmentOrdinal]))],
    };
  },
});

type ProposedFinding = Infer<typeof proposedFindingValidator>;
type ProposedCitation = ProposedFinding["citations"][number];

async function validatedCitations(
  ctx: MutationCtx,
  stores: readonly ChatResearchStore[],
  citations: readonly ProposedCitation[],
): Promise<Doc<"documentReviewFindings">["citations"]> {
  const result: Doc<"documentReviewFindings">["citations"] = [];
  const seen = new Set<string>();
  for (const citation of citations) {
    const key = `${citation.jurisdictionId}:${citation.resourceId}:${citation.versionId}:${citation.pageNumber ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const [checked] = await validateGovernedCitations(ctx, stores, [{
        jurisdictionId: citation.jurisdictionId,
        resourceId: citation.resourceId,
        versionId: citation.versionId,
        providerStoreName: citation.providerStoreName,
        ...(citation.providerDocumentName ? { providerDocumentName: citation.providerDocumentName } : {}),
        ...(citation.pageNumber === undefined ? {} : { pageNumber: citation.pageNumber }),
      }]);
      result.push({
        label: checked.label,
        ...(citation.provision ? { provision: citation.provision.slice(0, 160) } : {}),
        jurisdictionId: checked.jurisdictionId,
        jurisdictionName: checked.jurisdictionName,
        jurisdictionKind: checked.jurisdictionKind,
        relation: checked.relation,
        resourceId: citation.resourceId as Id<"legalResources">,
        versionId: citation.versionId as Id<"documentVersions">,
        providerStoreName: citation.providerStoreName,
        ...(citation.providerDocumentName ? { providerDocumentName: citation.providerDocumentName } : {}),
        ...(citation.pageNumber === undefined ? {} : { pageNumber: citation.pageNumber }),
      });
    } catch {
      // A source that is no longer published or in scope is dropped.
    }
    if (result.length >= LIMITS.maxCitationsPerFinding) break;
  }
  return result;
}

/** Saves one batch of checked findings. Legal conclusions without a valid source are downgraded. */
export const saveFindings = internalMutation({
  args: {
    reviewId: v.id("documentReviews"),
    attempt: v.number(),
    findings: v.array(proposedFindingValidator),
    pool: v.array(proposedFindingValidator.fields.citations.element),
    checkedOrdinals: v.array(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const active = await activeReview(ctx, args.reviewId, args.attempt, "checking");
    if (!active) return null;
    const { review } = active;
    const stores: ChatResearchStore[] = (await researchSnapshot(ctx, review._id))?.stores ?? [];
    const existing = await currentFindings(ctx, review);
    const covered = new Set(existing.flatMap((finding) => finding.segmentOrdinal === undefined ? [] : [finding.segmentOrdinal]));
    const titles = new Map<string, string>();
    for (const citation of args.pool.slice(0, 64)) {
      const resourceId = ctx.db.normalizeId("legalResources", citation.resourceId);
      if (!resourceId || titles.has(citation.resourceId)) continue;
      const resource = await ctx.db.get("legalResources", resourceId);
      if (resource?.jurisdictionId === citation.jurisdictionId) titles.set(citation.resourceId, resource.title);
    }
    const pool = args.pool.flatMap((citation) => titles.has(citation.resourceId) ? [{ ...citation, title: titles.get(citation.resourceId)! }] : []);
    let ordinal = existing.reduce((highest, finding) => Math.max(highest, finding.ordinal + 1), 0);
    let saved = existing.length;
    for (const finding of args.findings) {
      if (saved >= LIMITS.maxFindings + LIMITS.maxGapFindings) break;
      if (finding.segmentOrdinal !== undefined && (covered.has(finding.segmentOrdinal) || !args.checkedOrdinals.includes(finding.segmentOrdinal))) continue;
      const candidates = attachPooledCitations(finding, pool);
      const citations = finding.status === "unconfirmed" ? [] : await validatedCitations(ctx, stores, candidates);
      // Every legal conclusion needs a current, in-scope source.
      const status = citations.length === 0 && finding.status !== "unconfirmed" ? "unconfirmed" : finding.status;
      if (finding.kind === "missing" && status === "unconfirmed") continue;
      await ctx.db.insert("documentReviewFindings", {
        reviewId: review._id,
        attempt: review.attempt,
        ordinal: ordinal++,
        ...(finding.segmentOrdinal === undefined ? {} : { segmentOrdinal: finding.segmentOrdinal }),
        kind: finding.kind,
        status,
        title: finding.title,
        meaning: finding.meaning,
        lawSummary: status === "unconfirmed" && finding.status !== "unconfirmed"
          ? "We couldn't link this to a specific provision in the library, so it isn't confirmed."
          : finding.lawSummary,
        recommendation: finding.recommendation,
        ...(finding.suggestedWording && status !== "fine" ? { suggestedWording: finding.suggestedWording } : {}),
        citations,
      });
      saved += 1;
      if (finding.segmentOrdinal !== undefined) covered.add(finding.segmentOrdinal);
    }
    const checkedCount = Math.min(review.checkTotal ?? 0, (review.checkedCount ?? 0) + args.checkedOrdinals.length);
    await ctx.db.patch("documentReviews", review._id, { checkedCount, updatedAt: Date.now() });
    return null;
  },
});

export const summaryInput = internalQuery({
  args: { reviewId: v.id("documentReviews"), attempt: v.number() },
  returns: v.union(v.null(), v.object({
    documentType: v.string(), question: v.string(), role: v.string(), jurisdictionName: v.string(),
    findings: v.array(v.object({
      ref: v.optional(v.string()), kind: v.union(v.literal("passage"), v.literal("missing")),
      status: findingStatusValidator, title: v.string(), meaning: v.string(),
    })),
    counts: documentReviewCountsValidator,
  })),
  handler: async (ctx, args) => {
    const active = await activeReview(ctx, args.reviewId, args.attempt, "checking");
    if (!active) return null;
    const { review } = active;
    const findings = await currentFindings(ctx, review);
    const refs = await segmentRefs(ctx, review._id);
    return {
      documentType: review.documentType ?? "Document",
      question: review.question,
      role: review.roleId === NOT_SURE_ROLE.id ? "Not stated" : review.roleLabel ?? "Not stated",
      jurisdictionName: review.jurisdictionName,
      findings: sortFindings(findings).map((finding) => {
        const ref = finding.segmentOrdinal === undefined ? undefined : refs.get(finding.segmentOrdinal);
        return { ...(ref ? { ref } : {}), kind: finding.kind, status: finding.status, title: finding.title, meaning: finding.meaning };
      }),
      counts: countFindings(findings),
    };
  },
});

export const complete = internalMutation({
  args: {
    reviewId: v.id("documentReviews"), attempt: v.number(),
    headline: v.string(), overview: v.string(), nextSteps: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const active = await activeReview(ctx, args.reviewId, args.attempt, "checking");
    if (!active) return null;
    const findings = await currentFindings(ctx, active.review);
    const research = await researchSnapshot(ctx, active.review._id);
    const now = Date.now();
    await ctx.db.patch("documentReviews", active.review._id, {
      status: "completed",
      headline: args.headline.slice(0, 200),
      overview: args.overview.slice(0, 1_200),
      nextSteps: args.nextSteps.slice(0, 4).map((step) => step.slice(0, 240)),
      counts: countFindings(findings),
      partialCoverage: research?.partialCoverage === true,
      checkedCount: active.review.checkTotal ?? 0,
      completedAt: now,
      updatedAt: now,
    });
    return null;
  },
});

export const fail = internalMutation({
  args: { reviewId: v.id("documentReviews"), attempt: v.number(), failure: documentReviewFailureValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const review = await ctx.db.get("documentReviews", args.reviewId);
    if (!review || review.attempt !== args.attempt || (review.status !== "reading" && review.status !== "checking")) return null;
    await ctx.db.patch("documentReviews", review._id, { status: "failed", failure: args.failure, startRequested: false, updatedAt: Date.now() });
    return null;
  },
});

/** Removes a deleted chat's reviews in bounded batches. */
export const deleteForSessionBatch = internalMutation({
  args: { sessionId: v.id("chatSessions") },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const review = await ctx.db.query("documentReviews")
      .withIndex("by_sessionId_and_createdAt", (q) => q.eq("sessionId", args.sessionId))
      .first();
    if (!review) return { hasMore: false };
    const [segments, findings] = await Promise.all([
      ctx.db.query("documentReviewSegments").withIndex("by_reviewId_and_ordinal", (q) => q.eq("reviewId", review._id)).take(DELETE_BATCH_SIZE),
      ctx.db.query("documentReviewFindings").withIndex("by_reviewId_and_attempt_and_ordinal", (q) => q.eq("reviewId", review._id)).take(DELETE_BATCH_SIZE),
    ]);
    for (const row of segments) await ctx.db.delete("documentReviewSegments", row._id);
    for (const row of findings) await ctx.db.delete("documentReviewFindings", row._id);
    // Delete the review once its children are gone, so a running step stops on its next check.
    if (segments.length < DELETE_BATCH_SIZE && findings.length < DELETE_BATCH_SIZE) {
      const research = await ctx.db.query("documentReviewResearch").withIndex("by_reviewId", (q) => q.eq("reviewId", review._id)).unique();
      if (research) await ctx.db.delete("documentReviewResearch", research._id);
      await ctx.db.delete("documentReviews", review._id);
    }
    await ctx.scheduler.runAfter(0, deleteBatchRef, { sessionId: args.sessionId });
    return { hasMore: true };
  },
});
