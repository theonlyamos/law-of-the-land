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
  DEFAULT_DRAFT_REQUEST,
  DOCUMENT_DRAFT_LIMITS as LIMITS,
  NOT_SURE_SIDE,
  blankValueFor,
  cleanBlankValue,
  countBases,
  countPlaceholders,
  fillBlanks,
  splitBlanks,
  type BlankValue,
} from "../shared/document-draft";
import { researchSnapshotValidator } from "./lib/documentReviewContracts";
import {
  clauseBasisValidator,
  documentDraftFailureValidator,
  documentDraftStatusValidator,
  draftAnswerValidator,
  draftAudienceValidator,
  draftOptionValidator,
  draftPlanValidator,
  draftQuestionValidator,
  draftSectionValidator,
  proposedClauseCitationValidator,
  proposedClauseValidator,
  proposedFormalityValidator,
  storedFormalityValidator,
} from "./lib/documentDraftContracts";
import { attachPooledCitations } from "./lib/documentReviewModel";
import { publicFindingCitationValidator } from "./lib/documentReviewContracts";

type DraftCtx = QueryCtx | MutationCtx;
type StoredCitation = Doc<"documentDraftClauses">["citations"][number];
type ProposedCitation = Infer<typeof proposedClauseCitationValidator>;

const planRef = makeFunctionReference<"action">("documentDraftActions:plan");
const draftRef = makeFunctionReference<"action">("documentDraftActions:draft");
const reviseRef = makeFunctionReference<"action">("documentDraftActions:revise");
const deleteBatchRef = makeFunctionReference<"mutation">("documentDrafts:deleteForSessionBatch");
const DELETE_BATCH_SIZE = 50;
const MAX_CLAUSE_ROWS = LIMITS.maxSections + 1;
/** Every distinct blank once for the whole draft, plus a few per-clause values. */
const MAX_BLANK_ROWS = 500;

function unavailable(): never {
  throw new ConvexError("DOCUMENT_DRAFT_UNAVAILABLE");
}

async function ownedDraft(ctx: DraftCtx, draftId: Id<"documentDrafts">, userId: string): Promise<{ draft: Doc<"documentDrafts">; session: Doc<"chatSessions"> }> {
  const draft = await ctx.db.get("documentDrafts", draftId);
  if (!draft || draft.userId !== userId) unavailable();
  const session = await ctx.db.get("chatSessions", draft.sessionId);
  if (!session || session.userId !== userId || !(await canAccessSession(ctx, session))) unavailable();
  return { draft, session };
}

async function currentClauses(ctx: DraftCtx, draft: Doc<"documentDrafts">): Promise<Doc<"documentDraftClauses">[]> {
  return await ctx.db.query("documentDraftClauses")
    .withIndex("by_draftId_and_attempt_and_ordinal", (q) => q.eq("draftId", draft._id).eq("attempt", draft.attempt))
    .take(MAX_CLAUSE_ROWS);
}

async function draftBlanks(ctx: DraftCtx, draftId: Id<"documentDrafts">): Promise<BlankValue[]> {
  const rows = await ctx.db.query("documentDraftBlanks").withIndex("by_draftId_and_key", (q) => q.eq("draftId", draftId)).take(MAX_BLANK_ROWS);
  return rows.map((row) => ({ key: row.key, value: row.value, ...(row.clauseId ? { clauseId: row.clauseId } : {}) }));
}

const basisCountsValidator = v.object({ required: v.number(), protects: v.number(), common: v.number(), choice: v.number() });
const previewValidator = v.object({ heading: v.string(), basis: clauseBasisValidator });

const draftSummaryValidator = v.object({
  id: v.id("documentDrafts"),
  userClientId: v.string(),
  request: v.string(),
  status: documentDraftStatusValidator,
  attachmentFilename: v.optional(v.string()),
  documentType: v.optional(v.string()),
  title: v.optional(v.string()),
  summary: v.optional(v.string()),
  isLegalDocument: v.optional(v.boolean()),
  roleOptions: v.array(draftOptionValidator),
  suggestedRoleId: v.optional(v.string()),
  suggestedAudience: v.optional(draftAudienceValidator),
  questions: v.array(draftQuestionValidator),
  sectionCount: v.number(),
  roleLabel: v.optional(v.string()),
  audience: v.optional(draftAudienceValidator),
  startRequested: v.boolean(),
  draftedCount: v.number(),
  draftTotal: v.number(),
  counts: v.optional(basisCountsValidator),
  placeholderCount: v.number(),
  preview: v.array(previewValidator),
  failure: v.optional(documentDraftFailureValidator),
  jurisdictionName: v.string(),
  version: v.number(),
  createdAt: v.number(),
  completedAt: v.optional(v.number()),
});

async function summarize(ctx: DraftCtx, draft: Doc<"documentDrafts">): Promise<Infer<typeof draftSummaryValidator>> {
  let preview: Infer<typeof previewValidator>[] = [];
  let counts: Infer<typeof basisCountsValidator> | undefined;
  let placeholderCount = 0;
  if (draft.status === "drafting" || draft.status === "completed") {
    const clauses = await currentClauses(ctx, draft);
    preview = (draft.status === "drafting" ? clauses.slice(-5) : clauses.filter((clause) => clause.basis === "required").slice(0, 3))
      .map((clause) => ({ heading: clause.heading, basis: clause.basis }));
    if (draft.status === "completed") {
      counts = countBases(clauses);
      const blanks = await draftBlanks(ctx, draft._id);
      placeholderCount = countPlaceholders(clauses.map((clause) => fillBlanks(clause.text, clause._id, blanks)));
    }
  }
  const attachment = draft.attachmentId ? await ctx.db.get("chatAttachments", draft.attachmentId) : null;
  return {
    id: draft._id,
    userClientId: draft.userClientId,
    request: draft.request,
    status: draft.status,
    ...(attachment ? { attachmentFilename: attachment.filename } : {}),
    ...(draft.documentType ? { documentType: draft.documentType } : {}),
    ...(draft.title ? { title: draft.title } : {}),
    ...(draft.summary ? { summary: draft.summary } : {}),
    ...(draft.isLegalDocument === undefined ? {} : { isLegalDocument: draft.isLegalDocument }),
    roleOptions: draft.roleOptions ?? [],
    ...(draft.suggestedRoleId ? { suggestedRoleId: draft.suggestedRoleId } : {}),
    ...(draft.suggestedAudience ? { suggestedAudience: draft.suggestedAudience } : {}),
    questions: draft.questions ?? [],
    sectionCount: draft.sections?.length ?? 0,
    ...(draft.roleLabel ? { roleLabel: draft.roleLabel } : {}),
    ...(draft.audience ? { audience: draft.audience } : {}),
    startRequested: draft.startRequested === true,
    draftedCount: draft.draftedCount ?? 0,
    draftTotal: draft.draftTotal ?? 0,
    ...(counts ? { counts } : {}),
    placeholderCount,
    preview,
    ...(draft.failure ? { failure: draft.failure } : {}),
    jurisdictionName: draft.jurisdictionName,
    version: draft.version ?? 1,
    createdAt: draft.createdAt,
    ...(draft.completedAt === undefined ? {} : { completedAt: draft.completedAt }),
  };
}

/** Drafts in one chat, oldest first, for showing beside the messages that asked for them. */
export const listForChat = query({
  args: { externalId: v.string() },
  returns: v.array(draftSummaryValidator),
  handler: async (ctx, args) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return [];
    const session = await ctx.db.query("chatSessions")
      .withIndex("by_user_externalId", (q) => q.eq("userId", userId).eq("externalId", args.externalId))
      .unique();
    if (!session || !(await canAccessSession(ctx, session))) return [];
    const drafts = await ctx.db.query("documentDrafts")
      .withIndex("by_sessionId_and_createdAt", (q) => q.eq("sessionId", session._id))
      .take(LIMITS.maxDraftsPerChat);
    return await Promise.all(drafts.map((draft) => summarize(ctx, draft)));
  },
});

const clauseValidator = v.object({
  id: v.id("documentDraftClauses"),
  ordinal: v.number(),
  kind: draftSectionValidator.fields.kind,
  heading: v.string(),
  /** The wording with filled blanks written in. */
  text: v.string(),
  /** The wording split around its blanks, each with the value it shows in this clause. */
  parts: v.array(v.union(
    v.object({ kind: v.literal("text"), text: v.string() }),
    v.object({ kind: v.literal("blank"), key: v.string(), placeholder: v.string(), value: v.optional(v.string()), own: v.boolean() }),
  )),
  basis: clauseBasisValidator,
  why: v.string(),
  lawSummary: v.string(),
  citations: v.array(publicFindingCitationValidator),
  edited: v.boolean(),
  revising: v.boolean(),
  revisionFailed: v.boolean(),
});

/** Everything the draft workspace and the exporters need. */
export const get = query({
  args: { draftId: v.id("documentDrafts") },
  returns: v.union(v.null(), v.object({
    draft: draftSummaryValidator,
    answers: v.array(draftAnswerValidator),
    instructions: v.optional(v.string()),
    formalities: v.array(storedFormalityValidator),
    partialCoverage: v.boolean(),
    clauses: v.array(clauseValidator),
  })),
  handler: async (ctx, args) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return null;
    let owned: Awaited<ReturnType<typeof ownedDraft>>;
    try { owned = await ownedDraft(ctx, args.draftId, userId); } catch { return null; }
    const { draft } = owned;
    const clauses = await currentClauses(ctx, draft);
    const blanks = await draftBlanks(ctx, draft._id);
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
      draft: await summarize(ctx, draft),
      answers: draft.answers ?? [],
      ...(draft.instructions ? { instructions: draft.instructions } : {}),
      formalities: draft.formalities ?? [],
      partialCoverage: draft.partialCoverage === true,
      clauses: await Promise.all(clauses.map(async (clause) => ({
        id: clause._id,
        ordinal: clause.ordinal,
        kind: draft.sections?.[clause.ordinal]?.kind ?? "clause",
        heading: clause.heading,
        text: fillBlanks(clause.text, clause._id, blanks),
        parts: splitBlanks(clause.text).map((part) => {
          if (part.kind === "text") return part;
          const { value, own } = blankValueFor(part.key, clause._id, blanks);
          return { ...part, ...(value === undefined ? {} : { value }), own };
        }),
        basis: clause.basis,
        why: clause.why,
        lawSummary: clause.lawSummary,
        citations: await Promise.all(clause.citations.map(async (citation) => ({
          label: citation.label,
          ...(citation.provision ? { provision: citation.provision } : {}),
          jurisdictionName: citation.jurisdictionName,
          jurisdictionKind: citation.jurisdictionKind,
          relation: citation.relation,
          ...(citation.pageNumber === undefined ? {} : { pageNumber: citation.pageNumber }),
          previewable: await canPreview(citation.versionId, citation.resourceId),
        }))),
        edited: clause.edited,
        revising: clause.revising === true,
        revisionFailed: clause.revisionFailed === true,
      }))),
    };
  },
});

/**
 * Starts planning a document. The request must already be saved as a user
 * message in this chat. A file attached to that message can be used as source material.
 */
export const create = mutation({
  args: { externalId: v.string(), userClientId: v.string(), request: v.string(), attachmentId: v.optional(v.id("chatAttachments")) },
  returns: v.object({ draftId: v.id("documentDrafts") }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const session = await ownedAttachmentSession(ctx, args.externalId);
    if (!session.jurisdictionId || !session.jurisdictionName) unavailable();
    if (!args.userClientId.trim() || args.userClientId.length > 200) unavailable();
    const message = await ctx.db.query("messages")
      .withIndex("by_session_clientId", (q) => q.eq("sessionId", session._id).eq("clientId", args.userClientId))
      .unique();
    if (!message || message.role !== "user") unavailable();
    if (args.attachmentId) {
      const attachment = await ctx.db.get("chatAttachments", args.attachmentId);
      if (!attachment || attachment.sessionId !== session._id || attachment.userId !== userId || attachment.status !== "ready"
        || !attachment.storageId || attachment.messageClientId !== args.userClientId) unavailable();
    }

    const existing = await ctx.db.query("documentDrafts")
      .withIndex("by_sessionId_and_userClientId", (q) => q.eq("sessionId", session._id).eq("userClientId", args.userClientId))
      .first();
    if (existing) return { draftId: existing._id };
    const inChat = await ctx.db.query("documentDrafts")
      .withIndex("by_sessionId_and_createdAt", (q) => q.eq("sessionId", session._id))
      .take(LIMITS.maxDraftsPerChat);
    if (inChat.length >= LIMITS.maxDraftsPerChat) throw new ConvexError("DOCUMENT_DRAFT_LIMIT");

    await recordQuestionForUser(ctx, userId);
    const now = Date.now();
    const request = args.request.trim().slice(0, LIMITS.maxRequestCharacters) || DEFAULT_DRAFT_REQUEST;
    const draftId = await ctx.db.insert("documentDrafts", {
      sessionId: session._id,
      userId,
      userClientId: args.userClientId,
      request,
      ...(args.attachmentId ? { attachmentId: args.attachmentId } : {}),
      status: "planning",
      attempt: 1,
      version: 1,
      jurisdictionName: session.jurisdictionName,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, planRef, { draftId, attempt: 1 });
    return { draftId };
  },
});

function chosenSide(draft: Doc<"documentDrafts">, roleId: string | undefined): { roleId: string; roleLabel: string } {
  if (roleId === undefined || roleId === NOT_SURE_SIDE.id) return { roleId: NOT_SURE_SIDE.id, roleLabel: NOT_SURE_SIDE.label };
  const option = draft.roleOptions?.find((entry) => entry.id === roleId);
  if (!option) throw new ConvexError("DOCUMENT_DRAFT_INVALID_CHOICE");
  return { roleId: option.id, roleLabel: option.label };
}

function chosenAnswers(draft: Doc<"documentDrafts">, answers: readonly { questionId: string; value: string }[]): Infer<typeof draftAnswerValidator>[] {
  const questions = new Map((draft.questions ?? []).map((question) => [question.id, question]));
  if (answers.length > LIMITS.maxQuestions || new Set(answers.map((answer) => answer.questionId)).size !== answers.length) {
    throw new ConvexError("DOCUMENT_DRAFT_INVALID_CHOICE");
  }
  const result: Infer<typeof draftAnswerValidator>[] = [];
  for (const answer of answers) {
    const question = questions.get(answer.questionId);
    if (!question) throw new ConvexError("DOCUMENT_DRAFT_INVALID_CHOICE");
    const value = answer.value.trim().slice(0, LIMITS.maxAnswerCharacters);
    if (value) result.push({ questionId: question.id, label: question.label, value });
  }
  return result;
}

/** Captures the research scope with the person's own access, before any background step runs without it. */
async function captureResearch(ctx: MutationCtx, draft: Doc<"documentDrafts">, session: Doc<"chatSessions">, attempt: number) {
  let research: Infer<typeof researchSnapshotValidator>;
  try {
    research = await resolveChatResearchStoresForJurisdiction(ctx, session.jurisdictionId!, PUBLICATION_FILTER_PROTOCOL);
  } catch {
    throw new ConvexError("DOCUMENT_DRAFT_RESEARCH_UNAVAILABLE");
  }
  const existing = await ctx.db.query("documentDraftResearch").withIndex("by_draftId", (q) => q.eq("draftId", draft._id)).unique();
  if (existing) await ctx.db.replace("documentDraftResearch", existing._id, { draftId: draft._id, attempt, research });
  else await ctx.db.insert("documentDraftResearch", { draftId: draft._id, attempt, research });
}

async function researchSnapshot(ctx: DraftCtx, draftId: Id<"documentDrafts">) {
  return (await ctx.db.query("documentDraftResearch").withIndex("by_draftId", (q) => q.eq("draftId", draftId)).unique())?.research ?? null;
}

async function beginDrafting(ctx: MutationCtx, draft: Doc<"documentDrafts">, choices: {
  roleId: string; roleLabel: string; audience: "personal" | "professional"; answers: Infer<typeof draftAnswerValidator>[]; instructions?: string;
}) {
  await ctx.db.patch("documentDrafts", draft._id, {
    roleId: choices.roleId,
    roleLabel: choices.roleLabel,
    audience: choices.audience,
    answers: choices.answers,
    instructions: choices.instructions,
    status: "drafting",
    startRequested: false,
    draftedCount: 0,
    draftTotal: draft.sections?.length ?? 0,
    updatedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, draftRef, { draftId: draft._id, attempt: draft.attempt });
}

/** Records the person's answers and starts drafting (or queues the start while planning finishes). */
export const start = mutation({
  args: {
    draftId: v.id("documentDrafts"),
    roleId: v.optional(v.string()),
    audience: draftAudienceValidator,
    answers: v.array(v.object({ questionId: v.string(), value: v.string() })),
    instructions: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const { draft, session } = await ownedDraft(ctx, args.draftId, userId);
    if (draft.status !== "planning" && draft.status !== "awaiting_input") throw new ConvexError("DOCUMENT_DRAFT_NOT_READY");
    const instructions = args.instructions?.trim().slice(0, LIMITS.maxInstructionCharacters) || undefined;
    await captureResearch(ctx, draft, session, draft.attempt);
    if (draft.status === "planning") {
      // The questions are not known yet; keep the request and use the suggestions once planning finishes.
      await ctx.db.patch("documentDrafts", draft._id, { startRequested: true, audience: args.audience, instructions, updatedAt: Date.now() });
      return null;
    }
    await beginDrafting(ctx, draft, {
      ...chosenSide(draft, args.roleId), audience: args.audience, answers: chosenAnswers(draft, args.answers), ...(instructions ? { instructions } : {}),
    });
    return null;
  },
});

export const cancel = mutation({
  args: { draftId: v.id("documentDrafts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const { draft } = await ownedDraft(ctx, args.draftId, userId);
    if (draft.status !== "planning" && draft.status !== "drafting" && draft.status !== "awaiting_input") return null;
    // Bumping the attempt makes any running step discard its results.
    await ctx.db.patch("documentDrafts", draft._id, {
      status: "cancelled", failure: "cancelled", attempt: draft.attempt + 1, startRequested: false, updatedAt: Date.now(),
    });
    return null;
  },
});

/** Runs a failed or stopped draft again from the step it needs. */
export const retry = mutation({
  args: { draftId: v.id("documentDrafts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const { draft, session } = await ownedDraft(ctx, args.draftId, userId);
    if (draft.status !== "failed" && draft.status !== "cancelled") throw new ConvexError("DOCUMENT_DRAFT_NOT_RETRYABLE");
    const attempt = draft.attempt + 1;
    const hasPlan = (draft.sections?.length ?? 0) > 0;
    const hasChoices = draft.roleId !== undefined;
    if (hasPlan && hasChoices) await captureResearch(ctx, draft, session, attempt);
    // Earlier attempts' clauses are never shown again.
    const stale = await ctx.db.query("documentDraftClauses")
      .withIndex("by_draftId_and_attempt_and_ordinal", (q) => q.eq("draftId", draft._id).lt("attempt", attempt))
      .take(2 * MAX_CLAUSE_ROWS);
    for (const row of stale) await ctx.db.delete("documentDraftClauses", row._id);
    await ctx.db.patch("documentDrafts", draft._id, {
      attempt, failure: undefined, formalities: undefined, completedAt: undefined, draftedCount: 0, updatedAt: Date.now(),
      status: !hasPlan ? "planning" : hasChoices ? "drafting" : "awaiting_input",
    });
    if (!hasPlan) await ctx.scheduler.runAfter(0, planRef, { draftId: draft._id, attempt });
    else if (hasChoices) await ctx.scheduler.runAfter(0, draftRef, { draftId: draft._id, attempt });
    return null;
  },
});

async function ownedClause(ctx: MutationCtx, clauseId: Id<"documentDraftClauses">, userId: string) {
  const clause = await ctx.db.get("documentDraftClauses", clauseId);
  if (!clause) unavailable();
  const { draft, session } = await ownedDraft(ctx, clause.draftId, userId);
  if (clause.attempt !== draft.attempt) unavailable();
  if (draft.status !== "completed") throw new ConvexError("DOCUMENT_DRAFT_NOT_READY");
  return { clause, draft, session };
}

/** Saves the person's own wording for one clause. Its sources stay, marked as checked against the earlier wording. */
export const updateClause = mutation({
  args: { clauseId: v.id("documentDraftClauses"), heading: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const { clause, draft } = await ownedClause(ctx, args.clauseId, userId);
    if (clause.revising) throw new ConvexError("DOCUMENT_DRAFT_CLAUSE_BUSY");
    const text = args.text.replace(/\r\n?/gu, "\n").trim().slice(0, LIMITS.maxClauseCharacters);
    const heading = args.heading.replace(/\s+/gu, " ").trim().slice(0, LIMITS.maxClauseHeading);
    if (!text) throw new ConvexError("DOCUMENT_DRAFT_EMPTY_CLAUSE");
    if (text === clause.text && heading === clause.heading) return null;
    await ctx.db.patch("documentDraftClauses", clause._id, { text, heading, edited: true, revisionFailed: false });
    await ctx.db.patch("documentDrafts", draft._id, { version: (draft.version ?? 1) + 1, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Fills one blank. With `everywhere`, the value fills that blank in every
 * clause and replaces any clause's own value; without it, only this clause
 * changes. An empty value opens the blank again.
 */
export const setBlank = mutation({
  args: { clauseId: v.id("documentDraftClauses"), key: v.string(), value: v.string(), everywhere: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const { clause, draft } = await ownedClause(ctx, args.clauseId, userId);
    if (!splitBlanks(clause.text).some((part) => part.kind === "blank" && part.key === args.key)) {
      throw new ConvexError("DOCUMENT_DRAFT_UNKNOWN_BLANK");
    }
    const value = cleanBlankValue(args.value);
    const rows = await ctx.db.query("documentDraftBlanks")
      .withIndex("by_draftId_and_key", (q) => q.eq("draftId", draft._id).eq("key", args.key))
      .take(MAX_CLAUSE_ROWS + 1);
    const insert = async (clauseId?: Id<"documentDraftClauses">) => {
      const total = await ctx.db.query("documentDraftBlanks").withIndex("by_draftId_and_key", (q) => q.eq("draftId", draft._id)).take(MAX_BLANK_ROWS);
      if (total.length >= MAX_BLANK_ROWS) throw new ConvexError("DOCUMENT_DRAFT_TOO_MANY_BLANKS");
      await ctx.db.insert("documentDraftBlanks", { draftId: draft._id, key: args.key, value, ...(clauseId ? { clauseId } : {}) });
    };
    if (args.everywhere) {
      for (const row of rows) if (row.clauseId) await ctx.db.delete("documentDraftBlanks", row._id);
      const shared = rows.find((row) => !row.clauseId);
      if (shared && !value) await ctx.db.delete("documentDraftBlanks", shared._id);
      else if (shared) await ctx.db.patch("documentDraftBlanks", shared._id, { value });
      else if (value) await insert();
    } else {
      const own = rows.find((row) => row.clauseId === clause._id);
      if (own) await ctx.db.patch("documentDraftBlanks", own._id, { value });
      else await insert(clause._id);
    }
    await ctx.db.patch("documentDrafts", draft._id, { updatedAt: Date.now() });
    return null;
  },
});

/** Removes one clause from the document. */
export const removeClause = mutation({
  args: { clauseId: v.id("documentDraftClauses") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const { clause, draft } = await ownedClause(ctx, args.clauseId, userId);
    if (clause.revising) throw new ConvexError("DOCUMENT_DRAFT_CLAUSE_BUSY");
    const remaining = await currentClauses(ctx, draft);
    if (remaining.length <= 1) throw new ConvexError("DOCUMENT_DRAFT_LAST_CLAUSE");
    await ctx.db.delete("documentDraftClauses", clause._id);
    const blanks = await ctx.db.query("documentDraftBlanks").withIndex("by_draftId_and_key", (q) => q.eq("draftId", draft._id)).take(MAX_BLANK_ROWS);
    for (const row of blanks) if (row.clauseId === clause._id) await ctx.db.delete("documentDraftBlanks", row._id);
    await ctx.db.patch("documentDrafts", draft._id, { version: (draft.version ?? 1) + 1, updatedAt: Date.now() });
    return null;
  },
});

/** Asks for one clause to be rewritten against the law, following the person's instruction. Counts as one question. */
export const reviseClause = mutation({
  args: { clauseId: v.id("documentDraftClauses"), instruction: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const { clause, draft, session } = await ownedClause(ctx, args.clauseId, userId);
    if (clause.revising) throw new ConvexError("DOCUMENT_DRAFT_CLAUSE_BUSY");
    const instruction = args.instruction.trim().slice(0, LIMITS.maxInstructionCharacters);
    if (!instruction) throw new ConvexError("DOCUMENT_DRAFT_EMPTY_INSTRUCTION");
    await recordQuestionForUser(ctx, userId);
    // The library scope is captured again with the person's current access.
    await captureResearch(ctx, draft, session, draft.attempt);
    const revision = (clause.revision ?? 0) + 1;
    await ctx.db.patch("documentDraftClauses", clause._id, { revision, revising: true, revisionFailed: false });
    await ctx.scheduler.runAfter(0, reviseRef, { clauseId: clause._id, revision, instruction });
    return null;
  },
});

// ------------------------------------------------------------ internal steps

async function activeDraft(ctx: DraftCtx, draftId: Id<"documentDrafts">, attempt: number, status: Doc<"documentDrafts">["status"]) {
  const draft = await ctx.db.get("documentDrafts", draftId);
  if (!draft || draft.attempt !== attempt || draft.status !== status) return null;
  const session = await ctx.db.get("chatSessions", draft.sessionId);
  if (!session || session.userId !== draft.userId) return null;
  // Background steps have no signed-in user, so access is checked for the draft's owner.
  let memberships: Set<Id<"organizations">> | null;
  try { memberships = await activeOrganizationIdsForUser(ctx, draft.userId); } catch { memberships = null; }
  if (!(await canAccessSession(ctx, session, memberships))) return null;
  return { draft, session };
}

export const planningInput = internalQuery({
  args: { draftId: v.id("documentDrafts"), attempt: v.number() },
  returns: v.union(v.null(), v.object({
    request: v.string(),
    jurisdictionName: v.string(),
    context: v.string(),
    attachment: v.optional(v.object({
      storageId: v.id("_storage"),
      filename: v.string(),
      mimeType: v.string(),
      kind: v.union(v.literal("document"), v.literal("text"), v.literal("image")),
      byteSize: v.number(),
      extractedText: v.optional(v.string()),
    })),
  })),
  handler: async (ctx, args) => {
    const active = await activeDraft(ctx, args.draftId, args.attempt, "planning");
    if (!active) return null;
    const { draft, session } = active;
    // The last few saved turns, so "draft it" can follow on from the conversation.
    const recent = await ctx.db.query("messages")
      .withIndex("by_session_and_createdAt", (q) => q.eq("sessionId", session._id))
      .order("desc")
      .take(6);
    const context = recent.reverse()
      .filter((message) => message.clientId !== draft.userClientId)
      .map((message) => `${message.role}: ${message.content.slice(0, 1_200)}`)
      .join("\n\n")
      .slice(0, 4_000);
    let attachment: Doc<"chatAttachments"> | null = null;
    if (draft.attachmentId) {
      const row = await ctx.db.get("chatAttachments", draft.attachmentId);
      if (row && row.sessionId === session._id && row.status === "ready" && row.storageId) attachment = row;
    }
    return {
      request: draft.request,
      jurisdictionName: draft.jurisdictionName,
      context,
      ...(attachment ? { attachment: {
        storageId: attachment.storageId!,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        kind: attachment.kind,
        byteSize: attachment.byteSize,
        ...(attachment.extractedText === undefined ? {} : { extractedText: attachment.extractedText }),
      } } : {}),
    };
  },
});

function defaultAnswers(draft: Doc<"documentDrafts">): Infer<typeof draftAnswerValidator>[] {
  return (draft.questions ?? []).flatMap((question) => question.suggested
    ? [{ questionId: question.id, label: question.label, value: question.suggested }] : []);
}

export const savePlan = internalMutation({
  args: { draftId: v.id("documentDrafts"), attempt: v.number(), plan: draftPlanValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const active = await activeDraft(ctx, args.draftId, args.attempt, "planning");
    if (!active) return null;
    const { draft } = active;
    const { plan } = args;
    await ctx.db.patch("documentDrafts", draft._id, {
      status: "awaiting_input",
      documentType: plan.documentType,
      title: plan.title,
      summary: plan.summary,
      isLegalDocument: plan.isLegalDocument,
      roleOptions: plan.roleOptions.slice(0, LIMITS.maxRoleOptions),
      ...(plan.suggestedRoleId ? { suggestedRoleId: plan.suggestedRoleId } : {}),
      suggestedAudience: plan.suggestedAudience,
      questions: plan.questions.slice(0, LIMITS.maxQuestions),
      sections: plan.sections.slice(0, LIMITS.maxSections),
      ...(plan.sourceNotes ? { sourceNotes: plan.sourceNotes } : {}),
      updatedAt: Date.now(),
    });
    if (draft.startRequested) {
      const updated = (await ctx.db.get("documentDrafts", draft._id))!;
      await beginDrafting(ctx, updated, {
        ...chosenSide(updated, updated.suggestedRoleId),
        audience: updated.audience ?? updated.suggestedAudience ?? "personal",
        answers: defaultAnswers(updated),
        ...(updated.instructions ? { instructions: updated.instructions } : {}),
      });
    }
    return null;
  },
});

const draftContextValidator = v.object({
  jurisdictionName: v.string(),
  request: v.string(),
  documentType: v.string(),
  title: v.string(),
  summary: v.string(),
  side: v.string(),
  audience: draftAudienceValidator,
  answers: v.array(v.object({ label: v.string(), value: v.string() })),
  instructions: v.string(),
  outline: v.array(v.string()),
  sourceNotes: v.optional(v.string()),
});

function draftContext(draft: Doc<"documentDrafts">): Infer<typeof draftContextValidator> {
  return {
    jurisdictionName: draft.jurisdictionName,
    request: draft.request,
    documentType: draft.documentType ?? "Legal document",
    title: draft.title ?? draft.documentType ?? "Legal document",
    summary: draft.summary ?? "",
    side: draft.roleId === NOT_SURE_SIDE.id ? "Neutral" : draft.roleLabel ?? "Neutral",
    audience: draft.audience ?? "personal",
    answers: (draft.answers ?? []).map((answer) => ({ label: answer.label, value: answer.value })),
    instructions: draft.instructions ?? "",
    outline: (draft.sections ?? []).map((section, index) => `${index + 1}. ${section.heading}`),
    ...(draft.sourceNotes ? { sourceNotes: draft.sourceNotes } : {}),
  };
}

export const draftingInput = internalQuery({
  args: { draftId: v.id("documentDrafts"), attempt: v.number() },
  returns: v.union(v.null(), v.object({
    context: draftContextValidator,
    sections: v.array(v.object({ ordinal: v.number(), heading: v.string(), purpose: v.string(), kind: draftSectionValidator.fields.kind })),
    research: v.union(v.null(), researchSnapshotValidator),
    alreadyDrafted: v.array(v.number()),
    hasFormalities: v.boolean(),
  })),
  handler: async (ctx, args) => {
    const active = await activeDraft(ctx, args.draftId, args.attempt, "drafting");
    if (!active) return null;
    const { draft } = active;
    const clauses = await currentClauses(ctx, draft);
    return {
      context: draftContext(draft),
      sections: (draft.sections ?? []).map((section, ordinal) => ({ ordinal, ...section })),
      research: await researchSnapshot(ctx, draft._id),
      alreadyDrafted: clauses.map((clause) => clause.ordinal),
      hasFormalities: draft.formalities !== undefined,
    };
  },
});

/** Titles of the pooled citations' laws, read once so provision names can be matched. */
async function titledPool(ctx: MutationCtx, pool: readonly ProposedCitation[]) {
  const titles = new Map<string, string>();
  for (const citation of pool.slice(0, 64)) {
    const resourceId = ctx.db.normalizeId("legalResources", citation.resourceId);
    if (!resourceId || titles.has(citation.resourceId)) continue;
    const resource = await ctx.db.get("legalResources", resourceId);
    if (resource?.jurisdictionId === citation.jurisdictionId) titles.set(citation.resourceId, resource.title);
  }
  return pool.flatMap((citation) => titles.has(citation.resourceId) ? [{ ...citation, title: titles.get(citation.resourceId)! }] : []);
}

async function validatedCitations(ctx: MutationCtx, stores: readonly ChatResearchStore[], citations: readonly ProposedCitation[]): Promise<StoredCitation[]> {
  const result: StoredCitation[] = [];
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
    if (result.length >= LIMITS.maxCitationsPerClause) break;
  }
  return result;
}

type ProposedClause = Infer<typeof proposedClauseValidator>;

/** Validates a proposed clause's sources. A legal basis without a valid source becomes "No law cited". */
async function checkedClause(ctx: MutationCtx, stores: readonly ChatResearchStore[], clause: ProposedClause, pool: Awaited<ReturnType<typeof titledPool>>) {
  const legal = clause.basis === "required" || clause.basis === "protects";
  const candidates = legal ? attachPooledCitations({ status: "fine", lawSummary: clause.lawSummary, provisions: clause.provisions, citations: clause.citations }, pool) : [];
  const citations = legal ? await validatedCitations(ctx, stores, candidates) : [];
  const basis = legal && citations.length === 0 ? "common" as const : clause.basis;
  return {
    basis,
    citations,
    lawSummary: basis === "required" || basis === "protects" ? clause.lawSummary : "",
    tally: { legal, candidates: candidates.length, validated: citations.length, downgraded: legal && basis === "common" },
  };
}

/** Saves one batch of drafted clauses with their validated sources. */
export const saveClauses = internalMutation({
  args: {
    draftId: v.id("documentDrafts"),
    attempt: v.number(),
    clauses: v.array(proposedClauseValidator),
    pool: v.array(proposedClauseCitationValidator),
    draftedOrdinals: v.array(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const active = await activeDraft(ctx, args.draftId, args.attempt, "drafting");
    if (!active) return null;
    const { draft } = active;
    const sectionCount = draft.sections?.length ?? 0;
    const stores: ChatResearchStore[] = (await researchSnapshot(ctx, draft._id))?.stores ?? [];
    const existing = new Set((await currentClauses(ctx, draft)).map((clause) => clause.ordinal));
    const pool = await titledPool(ctx, args.pool);
    const tally = { proposed: args.clauses.length, legal: 0, candidates: 0, validated: 0, downgraded: 0 };
    for (const clause of args.clauses) {
      const ordinal = clause.sectionOrdinal;
      if (existing.has(ordinal) || ordinal < 0 || ordinal >= sectionCount || !args.draftedOrdinals.includes(ordinal)) continue;
      const checked = await checkedClause(ctx, stores, clause, pool);
      if (checked.tally.legal) tally.legal += 1;
      tally.candidates += checked.tally.candidates;
      tally.validated += checked.tally.validated;
      if (checked.tally.downgraded) tally.downgraded += 1;
      await ctx.db.insert("documentDraftClauses", {
        draftId: draft._id,
        attempt: draft.attempt,
        ordinal,
        heading: clause.heading || draft.sections![ordinal].heading,
        text: clause.text,
        basis: checked.basis,
        why: clause.why,
        lawSummary: checked.lawSummary,
        citations: checked.citations,
        edited: false,
      });
      existing.add(ordinal);
    }
    console.info("document_draft_save", JSON.stringify(tally));
    const draftedCount = Math.min(draft.draftTotal ?? sectionCount, (draft.draftedCount ?? 0) + args.draftedOrdinals.length);
    await ctx.db.patch("documentDrafts", draft._id, { draftedCount, updatedAt: Date.now() });
    return null;
  },
});

export const saveFormalities = internalMutation({
  args: {
    draftId: v.id("documentDrafts"),
    attempt: v.number(),
    items: v.array(proposedFormalityValidator),
    pool: v.array(proposedClauseCitationValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const active = await activeDraft(ctx, args.draftId, args.attempt, "drafting");
    if (!active) return null;
    const stores: ChatResearchStore[] = (await researchSnapshot(ctx, active.draft._id))?.stores ?? [];
    const pool = await titledPool(ctx, args.pool);
    const formalities: Infer<typeof storedFormalityValidator>[] = [];
    for (const item of args.items.slice(0, LIMITS.maxFormalities)) {
      const candidates = item.basis === "required"
        ? attachPooledCitations({ status: "fine", lawSummary: item.lawSummary, provisions: item.provisions, citations: item.citations }, pool) : [];
      const citations = candidates.length ? await validatedCitations(ctx, stores, candidates) : [];
      formalities.push({
        title: item.title,
        detail: item.detail,
        // A requirement without a valid source is shown as good practice.
        basis: item.basis === "required" && citations.length > 0 ? "required" : "common",
        citations: citations.map((citation) => ({ label: citation.label, ...(citation.provision ? { provision: citation.provision } : {}) })),
      });
    }
    await ctx.db.patch("documentDrafts", active.draft._id, { formalities, updatedAt: Date.now() });
    return null;
  },
});

export const complete = internalMutation({
  args: { draftId: v.id("documentDrafts"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const active = await activeDraft(ctx, args.draftId, args.attempt, "drafting");
    if (!active) return null;
    const now = Date.now();
    // Every planned section must be saved, drafted or as a blank, before the document is shown as finished.
    const saved = new Set((await currentClauses(ctx, active.draft)).map((clause) => clause.ordinal));
    const planned = active.draft.sections?.length ?? 0;
    if (planned === 0 || saved.size < planned) {
      await ctx.db.patch("documentDrafts", active.draft._id, { status: "failed", failure: "internal", startRequested: false, updatedAt: now });
      return null;
    }
    const research = await researchSnapshot(ctx, active.draft._id);
    await ctx.db.patch("documentDrafts", active.draft._id, {
      status: "completed",
      formalities: active.draft.formalities ?? [],
      partialCoverage: research?.partialCoverage === true,
      draftedCount: active.draft.draftTotal ?? 0,
      completedAt: now,
      updatedAt: now,
    });
    return null;
  },
});

export const fail = internalMutation({
  args: { draftId: v.id("documentDrafts"), attempt: v.number(), failure: documentDraftFailureValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const draft = await ctx.db.get("documentDrafts", args.draftId);
    if (!draft || draft.attempt !== args.attempt || (draft.status !== "planning" && draft.status !== "drafting")) return null;
    await ctx.db.patch("documentDrafts", draft._id, { status: "failed", failure: args.failure, startRequested: false, updatedAt: Date.now() });
    return null;
  },
});

async function activeRevision(ctx: DraftCtx, clauseId: Id<"documentDraftClauses">, revision: number) {
  const clause = await ctx.db.get("documentDraftClauses", clauseId);
  if (!clause || clause.revision !== revision || clause.revising !== true) return null;
  const active = await activeDraft(ctx, clause.draftId, clause.attempt, "completed");
  return active ? { ...active, clause } : null;
}

export const revisionInput = internalQuery({
  args: { clauseId: v.id("documentDraftClauses"), revision: v.number() },
  returns: v.union(v.null(), v.object({
    context: draftContextValidator,
    clause: v.object({ ordinal: v.number(), heading: v.string(), text: v.string() }),
    research: v.union(v.null(), researchSnapshotValidator),
  })),
  handler: async (ctx, args) => {
    const active = await activeRevision(ctx, args.clauseId, args.revision);
    if (!active) return null;
    return {
      context: draftContext(active.draft),
      clause: { ordinal: active.clause.ordinal, heading: active.clause.heading, text: active.clause.text },
      research: await researchSnapshot(ctx, active.draft._id),
    };
  },
});

export const saveRevision = internalMutation({
  args: {
    clauseId: v.id("documentDraftClauses"),
    revision: v.number(),
    clause: proposedClauseValidator,
    pool: v.array(proposedClauseCitationValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const active = await activeRevision(ctx, args.clauseId, args.revision);
    if (!active) return null;
    const stores: ChatResearchStore[] = (await researchSnapshot(ctx, active.draft._id))?.stores ?? [];
    const checked = await checkedClause(ctx, stores, args.clause, await titledPool(ctx, args.pool));
    await ctx.db.patch("documentDraftClauses", active.clause._id, {
      heading: args.clause.heading || active.clause.heading,
      text: args.clause.text,
      basis: checked.basis,
      why: args.clause.why,
      lawSummary: checked.lawSummary,
      citations: checked.citations,
      edited: false,
      revising: false,
      revisionFailed: false,
    });
    await ctx.db.patch("documentDrafts", active.draft._id, { version: (active.draft.version ?? 1) + 1, updatedAt: Date.now() });
    return null;
  },
});

export const failRevision = internalMutation({
  args: { clauseId: v.id("documentDraftClauses"), revision: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const clause = await ctx.db.get("documentDraftClauses", args.clauseId);
    if (!clause || clause.revision !== args.revision || clause.revising !== true) return null;
    await ctx.db.patch("documentDraftClauses", clause._id, { revising: false, revisionFailed: true });
    return null;
  },
});

/** Removes a deleted chat's drafts in bounded batches. */
export const deleteForSessionBatch = internalMutation({
  args: { sessionId: v.id("chatSessions") },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const draft = await ctx.db.query("documentDrafts")
      .withIndex("by_sessionId_and_createdAt", (q) => q.eq("sessionId", args.sessionId))
      .first();
    if (!draft) return { hasMore: false };
    const clauses = await ctx.db.query("documentDraftClauses")
      .withIndex("by_draftId_and_attempt_and_ordinal", (q) => q.eq("draftId", draft._id))
      .take(DELETE_BATCH_SIZE);
    for (const row of clauses) await ctx.db.delete("documentDraftClauses", row._id);
    const blanks = clauses.length < DELETE_BATCH_SIZE
      ? await ctx.db.query("documentDraftBlanks").withIndex("by_draftId_and_key", (q) => q.eq("draftId", draft._id)).take(DELETE_BATCH_SIZE)
      : [];
    for (const row of blanks) await ctx.db.delete("documentDraftBlanks", row._id);
    // Delete the draft once its clauses and blanks are gone, so a running step stops on its next check.
    if (clauses.length < DELETE_BATCH_SIZE && blanks.length < DELETE_BATCH_SIZE) {
      const research = await ctx.db.query("documentDraftResearch").withIndex("by_draftId", (q) => q.eq("draftId", draft._id)).unique();
      if (research) await ctx.db.delete("documentDraftResearch", research._id);
      await ctx.db.delete("documentDrafts", draft._id);
    }
    await ctx.scheduler.runAfter(0, deleteBatchRef, { sessionId: args.sessionId });
    return { hasMore: true };
  },
});
