import { ConvexError, v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { validateGovernedCitations } from "./chats";
import { chatResearchStoresValidator, resolveChatResearchStoresForJurisdiction } from "./jurisdictions";
import { consumeRateBucket } from "./lib/rateBuckets";
import { optionalUserId } from "./lib/requireUser";
import { CHAT_NO_EVIDENCE } from "./lib/chatNoEvidence";
import { isChatPolicyResponse } from "./lib/chatPolicy";
import { PUBLICATION_FILTER_PROTOCOL } from "../shared/gemini-publication-filter";
import { validWidgetRequestId, widgetCitationIdentityValidator, type CitationIdentity } from "./lib/widgetContracts";
import {
  GUEST_RESEARCH_LIMIT, GUEST_RESEARCH_LIFETIME_MS, guestErrorValidator, guestSessionResponseValidator,
  guestTurnValidator, type GuestError, type GuestSessionView, type GuestTurnView,
} from "./lib/guestResearchContracts";

const capabilityArgs = { publicationFilterProtocol: v.optional(v.literal(PUBLICATION_FILTER_PROTOCOL)) };
const sessionArgs = { tokenHash: v.string(), ...capabilityArgs };
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 20;
const failureValidator = v.object({ error: guestErrorValidator });
const admissionValidator = v.union(
  v.object({ kind: v.literal("denied"), error: guestErrorValidator }),
  v.object({ kind: v.literal("existing"), turn: guestTurnValidator }),
  v.object({
    kind: v.literal("admitted"), turnId: v.id("guestResearchTurns"), attemptNonce: v.string(), manifest: chatResearchStoresValidator,
    messages: v.array(v.object({ role: v.union(v.literal("user"), v.literal("assistant")), content: v.string() })),
  }),
);
export type GuestAdmission = import("convex/values").Infer<typeof admissionValidator>;

function error(code: GuestError["code"], retryAfterSeconds?: number): GuestError {
  const messages: Partial<Record<GuestError["code"], string>> = {
    TRIAL_EXHAUSTED: "Create a free account to continue this research.",
    AUTH_REQUIRED: "Sign in to save this research.",
    SESSION_INVALID: "This research session is unavailable. Start from the homepage.",
    SESSION_EXPIRED: "This temporary research session has expired.",
    WIDGET_UNAVAILABLE: "Guest research is unavailable for this jurisdiction right now.",
    LIBRARY_CHANGED: "The published sources changed during this conversation. Start new research to continue.",
    GENERATION_BUSY: "An answer is still being processed. Please wait.",
    GENERATION_TIMEOUT: "The answer timed out. Please try again; your free answer is still available.",
    ALLOWANCE_EXHAUSTED: "Guest research has reached today's request budget. Sign in to continue.",
    RATE_LIMITED: "Please wait before trying again.",
    INVALID_REQUEST: "Enter a question of 4,000 characters or fewer.",
    REQUEST_CONFLICT: "This request does not match the original question.",
  };
  return { code, message: messages[code] ?? "We couldn't finish this answer. Please try again.", ...(retryAfterSeconds ? { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) } : {}) };
}
function fail(code: GuestError["code"]): never { throw new ConvexError(code); }
function failure(caught: unknown): { error: GuestError } {
  if (!(caught instanceof ConvexError)) throw caught;
  const code = String(caught.data);
  const known = ["SESSION_INVALID", "SESSION_EXPIRED", "LIBRARY_CHANGED", "AUTH_REQUIRED", "GENERATION_BUSY", "INVALID_REQUEST", "TRIAL_EXHAUSTED"];
  return { error: error(known.includes(code) ? code as GuestError["code"] : "WIDGET_UNAVAILABLE") };
}
function enabled() { if (process.env.GUEST_RESEARCH_ENABLED !== "true") fail("WIDGET_UNAVAILABLE"); }
function validToken(tokenHash: string) { if (!/^[A-Za-z0-9_-]{43}$/.test(tokenHash)) fail("SESSION_INVALID"); }
function validIp(ipKey: string) { if (!/^[A-Za-z0-9_-]{1,128}$/.test(ipKey)) fail("INVALID_REQUEST"); }

async function publicScope(ctx: MutationCtx, jurisdictionId: Id<"jurisdictions">, publicationFilterProtocol?: typeof PUBLICATION_FILTER_PROTOCOL) {
  const selected = await ctx.db.get(jurisdictionId);
  // Explicit even with an authenticated adoption request: guest authority never includes membership.
  if (!selected || selected.visibility !== "public") fail("WIDGET_UNAVAILABLE");
  const manifest = await resolveChatResearchStoresForJurisdiction(ctx, jurisdictionId, publicationFilterProtocol);
  const revisions = [];
  const legacyLocks = await ctx.db.query("documentLifecycleLocks").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", undefined)).take(1);
  if (legacyLocks.length) fail("WIDGET_UNAVAILABLE");
  for (const store of manifest.stores) {
    const row = await ctx.db.get(store.jurisdictionId);
    if (!row || row.visibility !== "public") fail("WIDGET_UNAVAILABLE");
    const locks = await ctx.db.query("documentLifecycleLocks").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", row._id)).take(1);
    if (locks.length) fail("WIDGET_UNAVAILABLE");
    for (const status of ["queued", "running", "waiting_provider", "manual_review"] as const) {
      const jobs = await ctx.db.query("integrationJobs").withIndex("by_targetType_and_targetId_and_type_and_status", q => q.eq("targetType", "jurisdictionGeminiStore").eq("targetId", row._id).eq("type", "gemini_delete_store").eq("status", status)).take(1);
      if (jobs.length) fail("WIDGET_UNAVAILABLE");
    }
    revisions.push(row.contentRevision ?? 0);
  }
  return { manifest, binding: JSON.stringify([manifest, revisions]) };
}
async function sessionFor(ctx: MutationCtx, tokenHash: string, publicationFilterProtocol?: typeof PUBLICATION_FILTER_PROTOCOL) {
  enabled(); validToken(tokenHash);
  const session = await ctx.db.query("guestResearchSessions").withIndex("by_tokenHash", q => q.eq("tokenHash", tokenHash)).unique();
  if (!session) fail("SESSION_INVALID");
  if (session.expiresAt <= Date.now()) fail("SESSION_EXPIRED");
  const scope = await publicScope(ctx, session.jurisdictionId, publicationFilterProtocol);
  if (scope.binding !== session.scopeBinding) fail("LIBRARY_CHANGED");
  return { session, manifest: scope.manifest };
}
function turnView(turn: Doc<"guestResearchTurns">): GuestTurnView {
  return { requestId: turn.requestId, query: turn.query, status: turn.status, ...(turn.result ? { result: turn.result } : {}), ...(turn.error ? { error: turn.error } : {}) };
}
async function sessionTurns(ctx: MutationCtx, session: Doc<"guestResearchSessions">) {
  const turns = await ctx.db.query("guestResearchTurns").withIndex("by_sessionId", q => q.eq("sessionId", session._id)).take(MAX_ATTEMPTS + 1);
  if (turns.length > MAX_ATTEMPTS) fail("SESSION_INVALID");
  for (const turn of turns) {
    if (turn.status === "pending" && turn.leaseExpiresAt <= Date.now()) {
      const update = { status: "failed" as const, holdsSlot: false, error: error("GENERATION_TIMEOUT") };
      await ctx.db.patch(turn._id, update);
      Object.assign(turn, update);
    }
  }
  return turns;
}
async function view(ctx: MutationCtx, tokenHash: string, publicationFilterProtocol?: typeof PUBLICATION_FILTER_PROTOCOL): Promise<GuestSessionView> {
  const { session, manifest } = await sessionFor(ctx, tokenHash, publicationFilterProtocol);
  const turns = await sessionTurns(ctx, session);
  for (const turn of turns) if (turn.status === "completed") await validateGovernedCitations(ctx, manifest.stores, turn.citations ?? []);
  const selected = manifest.stores[0];
  return {
    jurisdictionId: session.jurisdictionId, jurisdictionName: selected.name, jurisdictionKind: selected.kind,
    expiresAt: session.expiresAt, remaining: Math.max(0, GUEST_RESEARCH_LIMIT - turns.filter(turn => turn.status === "completed").length),
    turns: turns.map(turnView), ...(session.chatId ? { chatId: session.chatId } : {}),
  };
}

export const createSession = internalMutation({
  args: { ...sessionArgs, jurisdictionId: v.string(), ipKey: v.string() }, returns: guestSessionResponseValidator,
  handler: async (ctx, args) => {
    try {
      enabled(); validToken(args.tokenHash); validIp(args.ipKey);
      const old = await ctx.db.query("guestResearchSessions").withIndex("by_tokenHash", q => q.eq("tokenHash", args.tokenHash)).unique();
      if (old) { if (old.jurisdictionId !== args.jurisdictionId) fail("SESSION_INVALID"); return await view(ctx, args.tokenHash, args.publicationFilterProtocol); }
      const jurisdictionId = ctx.db.normalizeId("jurisdictions", args.jurisdictionId);
      if (!jurisdictionId) fail("INVALID_REQUEST");
      const scope = await publicScope(ctx, jurisdictionId, args.publicationFilterProtocol);
      const retry = await consumeRateBucket(ctx, "guest-sessions", args.ipKey, 5, 60 * 60_000);
      if (retry) return { error: error("RATE_LIMITED", retry) };
      const now = Date.now();
      await ctx.db.insert("guestResearchSessions", { tokenHash: args.tokenHash, jurisdictionId, scopeBinding: scope.binding, createdAt: now, expiresAt: now + GUEST_RESEARCH_LIFETIME_MS, attempts: 0 });
      return await view(ctx, args.tokenHash, args.publicationFilterProtocol);
    } catch (caught) { return failure(caught); }
  },
});
export const readSession = internalMutation({
  args: sessionArgs, returns: guestSessionResponseValidator,
  handler: async (ctx, args) => { try { return await view(ctx, args.tokenHash, args.publicationFilterProtocol); } catch (caught) { return failure(caught); } },
});
export const beginTurn = internalMutation({
  args: { ...sessionArgs, requestId: v.string(), query: v.string(), ipKey: v.string() }, returns: admissionValidator,
  handler: async (ctx, args): Promise<GuestAdmission> => {
    try {
      validIp(args.ipKey);
      if (!validWidgetRequestId(args.requestId) || !args.query.trim() || args.query.length > 4000) fail("INVALID_REQUEST");
      const { session, manifest } = await sessionFor(ctx, args.tokenHash, args.publicationFilterProtocol);
      if (session.adoptedBy) fail("TRIAL_EXHAUSTED");
      const turns = await sessionTurns(ctx, session);
      const old = turns.find(turn => turn.requestId === args.requestId);
      if (old) {
        if (old.query !== args.query.trim()) return { kind: "denied", error: error("REQUEST_CONFLICT") };
        if (old.status === "completed") await validateGovernedCitations(ctx, manifest.stores, old.citations ?? []);
        return { kind: "existing", turn: turnView(old) };
      }
      const completed = turns.filter(turn => turn.status === "completed");
      if (completed.length >= GUEST_RESEARCH_LIMIT) fail("TRIAL_EXHAUSTED");
      if (turns.some(turn => turn.holdsSlot && turn.leaseExpiresAt > Date.now())) fail("GENERATION_BUSY");
      if (session.attempts >= MAX_ATTEMPTS) return { kind: "denied", error: error("RATE_LIMITED", (session.expiresAt - Date.now()) / 1000) };
      const retry = await consumeRateBucket(ctx, "guest-questions", args.ipKey, 10, 60 * 60_000);
      if (retry) return { kind: "denied", error: error("RATE_LIMITED", retry) };
      const configured = Number(process.env.GUEST_RESEARCH_DAILY_BUDGET ?? "100");
      const dailyBudget = Number.isSafeInteger(configured) && configured >= 0 ? configured : 100;
      // ponytail: one daily counter, shard only if guest admission contention becomes measurable.
      const budgetRetry = await consumeRateBucket(ctx, "guest-platform", "daily", dailyBudget, GUEST_RESEARCH_LIFETIME_MS);
      if (budgetRetry) return { kind: "denied", error: error("ALLOWANCE_EXHAUSTED", budgetRetry) };
      const messages: { role: "user" | "assistant"; content: string }[] = [];
      for (const turn of completed) {
        await validateGovernedCitations(ctx, manifest.stores, turn.citations ?? []);
        messages.push({ role: "user", content: turn.query }, { role: "assistant", content: turn.result!.answer });
      }
      const now = Date.now(), attemptNonce = crypto.randomUUID();
      const turnId = await ctx.db.insert("guestResearchTurns", { sessionId: session._id, requestId: args.requestId, query: args.query.trim(), attemptNonce, status: "pending", holdsSlot: true, leaseExpiresAt: now + LEASE_MS, createdAt: now, expiresAt: session.expiresAt });
      await ctx.db.patch(session._id, { attempts: session.attempts + 1 });
      return { kind: "admitted", turnId, attemptNonce, manifest, messages };
    } catch (caught) { return { kind: "denied", ...failure(caught) }; }
  },
});

export const finishTurn = internalMutation({
  args: {
    ...capabilityArgs,
    turnId: v.id("guestResearchTurns"), attemptNonce: v.string(), outcome: v.union(v.literal("completed"), v.literal("failed"), v.literal("aborted")),
    answer: v.optional(v.string()), answerKind: v.optional(v.union(v.literal("legal"), v.literal("policy"))), citations: v.array(widgetCitationIdentityValidator),
    error: v.optional(guestErrorValidator), providerFinished: v.boolean(),
  }, returns: guestTurnValidator,
  handler: async (ctx, args) => {
    const turn = await ctx.db.get(args.turnId);
    if (!turn || turn.attemptNonce !== args.attemptNonce) fail("INVALID_REQUEST");
    if (turn.status !== "pending") {
      if (args.providerFinished && turn.holdsSlot) await ctx.db.patch(turn._id, { holdsSlot: false });
      // Replays acknowledge only; readSession rechecks authority before releasing stored answers.
      return { requestId: turn.requestId, query: turn.query, status: turn.status, ...(turn.error ? { error: turn.error } : {}) };
    }
    let result: Doc<"guestResearchTurns">["result"], terminalError = args.error;
    try {
      const session = await ctx.db.get(turn.sessionId);
      if (!session) fail("SESSION_INVALID");
      const { manifest } = await sessionFor(ctx, session.tokenHash, args.publicationFilterProtocol);
      if (session.adoptedBy) fail("SESSION_INVALID");
      if (turn.leaseExpiresAt <= Date.now()) fail("GENERATION_TIMEOUT");
      if (args.outcome === "completed") {
        const answerKind = args.answerKind ?? "legal";
        if (!args.answer?.trim() || new TextEncoder().encode(args.answer).byteLength > 65536 ||
          (answerKind === "policy" ? args.citations.length !== 0 || !isChatPolicyResponse(args.answer) : !args.citations.length && args.answer !== CHAT_NO_EVIDENCE)) fail("ANSWER_UNAVAILABLE");
        const citations = await sources(ctx, manifest.stores, args.citations);
        result = { requestId: turn.requestId, answer: args.answer, answerKind, partialCoverage: manifest.partialCoverage, citations, completedAt: Date.now() };
      }
    } catch (caught) {
      if (!(caught instanceof ConvexError)) throw caught;
      terminalError = error(String(caught.data) === "GENERATION_TIMEOUT" ? "GENERATION_TIMEOUT" : "ANSWER_UNAVAILABLE");
    }
    const status = terminalError ? "failed" : args.outcome;
    if (status !== "completed") result = undefined;
    await ctx.db.patch(turn._id, { status, holdsSlot: !args.providerFinished, result, citations: result ? args.citations : undefined, error: terminalError ?? (status === "completed" ? undefined : error("ANSWER_UNAVAILABLE")) });
    return turnView((await ctx.db.get(turn._id))!);
  },
});
async function sources(ctx: MutationCtx, stores: import("./jurisdictions").ChatResearchStore[], citations: CitationIdentity[]) {
  const validated = await validateGovernedCitations(ctx, stores, citations);
  return Promise.all(validated.map(async (citation, index) => {
    const resourceId = ctx.db.normalizeId("legalResources", citations[index].resourceId);
    const versionId = ctx.db.normalizeId("documentVersions", citations[index].versionId);
    const resource = resourceId ? await ctx.db.get(resourceId) : null;
    const version = versionId ? await ctx.db.get(versionId) : null;
    if (!resource || !version) fail("ANSWER_UNAVAILABLE");
    return { ...citation, issuer: resource.issuer, officialCitation: resource.officialCitation, effectiveDate: version.effectiveDate ?? resource.effectiveDate ?? null, sourceUrl: version.sourceUrl || resource.sourceUrl || null };
  }));
}

export const adoptSession = internalMutation({
  args: sessionArgs, returns: v.union(v.object({ chatId: v.string() }), failureValidator),
  handler: async (ctx, args) => {
    try {
      const userId = await optionalUserId(ctx);
      if (!userId) fail("AUTH_REQUIRED");
      const { session, manifest } = await sessionFor(ctx, args.tokenHash, args.publicationFilterProtocol);
      if (session.adoptedBy) {
        if (session.adoptedBy !== userId || !session.chatId) fail("SESSION_INVALID");
        return { chatId: session.chatId };
      }
      const turns = await sessionTurns(ctx, session);
      if (turns.some(turn => turn.holdsSlot && turn.leaseExpiresAt > Date.now())) fail("GENERATION_BUSY");
      const completed = turns.filter(turn => turn.status === "completed" && turn.result);
      if (!completed.length) fail("INVALID_REQUEST");
      const sourceSets = await Promise.all(completed.map(turn => sources(ctx, manifest.stores, turn.citations ?? [])));
      const chatId = crypto.randomUUID(), selected = manifest.stores[0], now = Date.now();
      const chatSessionId = await ctx.db.insert("chatSessions", {
        userId, externalId: chatId, title: completed[0].query.slice(0, 100), lastMessage: completed[completed.length - 1].result!.answer.slice(0, 200), messageCount: completed.length * 2, updatedAt: now,
        jurisdictionId: session.jurisdictionId, jurisdictionName: selected.name, jurisdictionKind: selected.kind, jurisdictionContract: "unified",
      });
      for (let index = 0; index < completed.length; index++) {
        const turn = completed[index];
        const guestSources = sourceSets[index];
        const citations = guestSources.map(({ label, jurisdictionId, jurisdictionName, jurisdictionKind, relation }) => ({ label, jurisdictionId, jurisdictionName, jurisdictionKind, relation }));
        // Both messages and citations come from canonical, server-validated guest records.
        await ctx.db.insert("messages", { sessionId: chatSessionId, role: "user", content: turn.query, clientId: `guest-user-${turn.requestId}`, createdAt: turn.createdAt });
        await ctx.db.insert("messages", { sessionId: chatSessionId, role: "assistant", content: turn.result!.answer, answerKind: turn.result!.answerKind, citations, guestSources, clientId: `guest-assistant-${turn.requestId}`, createdAt: turn.result!.completedAt });
      }
      await ctx.db.patch(session._id, { adoptedBy: userId, chatId });
      return { chatId };
    } catch (caught) { return failure(caught); }
  },
});
export const cleanup = internalMutation({
  args: { table: v.union(v.literal("sessions"), v.literal("turns")) }, returns: v.null(),
  handler: async (ctx, args) => {
    const rows = args.table === "sessions"
      ? await ctx.db.query("guestResearchSessions").withIndex("by_expiresAt", q => q.lte("expiresAt", Date.now())).take(100)
      : await ctx.db.query("guestResearchTurns").withIndex("by_expiresAt", q => q.lte("expiresAt", Date.now())).take(100);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === 100) await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation">("guestResearch:cleanup"), args);
    return null;
  },
});
