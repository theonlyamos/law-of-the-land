import { ConvexError, v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { resolveWidgetAuthority } from "./lib/widgetAuthority";
import { validateGovernedCitations } from "./chats";
import { CHAT_NO_EVIDENCE } from "./lib/chatNoEvidence";
import { hashOpaqueTelemetryValue } from "./lib/telemetryProof";
import { WIDGET_LIMITS, validWidgetRequestId, widgetCitationIdentityValidator, widgetErrorValidator, type WidgetError, type WidgetErrorCode, type WidgetTurnView, type WidgetSource } from "./lib/widgetContracts";

const sessionArgs = { publicId: v.string(), tokenHash: v.string() };
const turnArgs = { ...sessionArgs, requestId: v.string(), ipKey: v.string() };
const encoder = new TextEncoder();
const cleanupRef = makeFunctionReference<"mutation">("widgetRuntime:cleanup");
type Authority = Awaited<ReturnType<typeof resolveWidgetAuthority>>;
export type Admission = { kind: "denied"; error: WidgetError } | { kind: "existing"; turn: WidgetTurnView } | {
  kind: "admitted"; turnId: Id<"widgetTurns">; attemptNonce: string;
  authority: Pick<Authority, "organizationId" | "jurisdictionId" | "accessVersion" | "contentRevision" | "store">;
  messages: { role: "user" | "assistant"; content: string }[];
};
function error(code: WidgetErrorCode, retryAfterSeconds?: number): WidgetError {
  const messages: Record<WidgetErrorCode, string> = {
    INVALID_REQUEST: "Enter a question of 4,000 characters or fewer.", BODY_TOO_LARGE: "This question is too large to send.", WIDGET_UNAVAILABLE: "This assistant isn't available right now. Please contact the organization for help.",
    SESSION_EXPIRED: "This conversation has expired.", SESSION_INVALID: "Start a new conversation to continue.", RATE_LIMITED: "Please wait before trying again.", ALLOWANCE_EXHAUSTED: "This assistant has reached its usage limit. Please try again after the limit resets.",
    GENERATION_BUSY: "Another answer is still being processed. Please wait before asking again.", REQUEST_CONFLICT: "This question couldn't be sent. Please try again.", LIBRARY_CHANGED: "The published documents changed during this conversation.", GENERATION_TIMEOUT: "We couldn't finish this answer.", ANSWER_UNAVAILABLE: "We couldn't finish this answer.", TURN_NOT_FOUND: "This answer could not be found.",
  };
  return { code, message: messages[code], ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) }) };
}
function codeFrom(caught: unknown): WidgetErrorCode {
  if (caught instanceof ConvexError && ["SESSION_EXPIRED", "SESSION_INVALID", "LIBRARY_CHANGED"].includes(String(caught.data))) return caught.data as WidgetErrorCode;
  return "WIDGET_UNAVAILABLE";
}
function enabled() { if (process.env.WIDGET_CHAT_ENABLED !== "true") throw new ConvexError("WIDGET_UNAVAILABLE"); }
async function rate(ctx: MutationCtx, namespace: string, key: string, limit: number, windowMs = 60_000): Promise<number> {
  const now = Date.now(), window = Math.floor(now / windowMs);
  const row = await ctx.db.query("widgetRateBuckets").withIndex("by_namespace_and_key_and_window", q => q.eq("namespace", namespace).eq("key", key).eq("window", window)).unique();
  const expiresAt = (window + 1) * windowMs;
  if (row) await ctx.db.patch(row._id, { count: Math.min(row.count + 1, limit + 1) });
  else await ctx.db.insert("widgetRateBuckets", { namespace, key, window, count: 1, expiresAt });
  return (row?.count ?? 0) >= limit ? Math.ceil((expiresAt - now) / 1000) : 0;
}
async function boundSession(ctx: MutationCtx, input: { publicId: string; tokenHash: string }) {
  enabled();
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.tokenHash) || input.publicId.length > 100) throw new ConvexError("SESSION_INVALID");
  const session = await ctx.db.query("widgetSessions").withIndex("by_tokenHash", q => q.eq("tokenHash", input.tokenHash)).unique();
  if (!session || session.revokedAt !== undefined) throw new ConvexError("SESSION_INVALID");
  if (session.expiresAt <= Date.now() || session.deleteAfter <= Date.now()) throw new ConvexError("SESSION_EXPIRED");
  const authority = await resolveWidgetAuthority(ctx, input.publicId, session.parentOrigin);
  if (authority.widget._id !== session.widgetId || authority.organizationId !== session.organizationId) throw new ConvexError("SESSION_INVALID");
  if (session.contentRevision !== authority.contentRevision || session.accessVersion !== authority.accessVersion) {
    await ctx.db.patch(session._id, { revokedAt: Date.now() });
    throw new ConvexError("LIBRARY_CHANGED");
  }
  return { session, authority };
}
function view(turn: Doc<"widgetTurns">): WidgetTurnView {
  return { requestId: turn.requestId, status: turn.status, ...(turn.result ? { result: turn.result } : {}), ...(turn.error ? { error: turn.error } : {}), ...(turn.status === "pending" ? { retryAfterSeconds: 2 } : {}) };
}
export const createSession = internalMutation({ args: { ...sessionArgs, parentOrigin: v.string(), ipKey: v.string() }, handler: async (ctx, args) => {
  try {
    enabled();
    if (!/^[A-Za-z0-9_-]{43}$/.test(args.tokenHash) || !args.ipKey || args.ipKey.length > 128) return { error: error("INVALID_REQUEST") };
    const authority = await resolveWidgetAuthority(ctx, args.publicId, args.parentOrigin);
    const existing = await ctx.db.query("widgetSessions").withIndex("by_tokenHash", q => q.eq("tokenHash", args.tokenHash)).unique();
    if (existing) {
      const binding = await boundSession(ctx, args);
      if (binding.session.parentOrigin !== args.parentOrigin) return { error: error("SESSION_INVALID") };
      return { expiresAt: existing.expiresAt };
    }
    const retry = await rate(ctx, "sessions", `${authority.organizationId}:${args.ipKey}`, 20, 600_000);
    if (retry) return { error: error("RATE_LIMITED", retry) };
    const now = Date.now(), expiresAt = now + WIDGET_LIMITS.idleMs;
    await ctx.db.insert("widgetSessions", { widgetId: authority.widget._id, organizationId: authority.organizationId, tokenHash: args.tokenHash, parentOrigin: args.parentOrigin, accessVersion: authority.accessVersion, contentRevision: authority.contentRevision, createdAt: now, lastUsedAt: now, expiresAt, deleteAfter: now + WIDGET_LIMITS.lifetimeMs });
    return { expiresAt };
  } catch (caught) { if (!(caught instanceof ConvexError)) throw caught; return { error: error(codeFrom(caught)) }; }
} });
export const beginTurn = internalMutation({ args: { ...turnArgs, query: v.string() }, handler: async (ctx, args): Promise<Admission> => {
  if (!validWidgetRequestId(args.requestId) || !args.query.trim() || args.query.length > WIDGET_LIMITS.query || !args.ipKey || args.ipKey.length > 128) return { kind: "denied", error: error("INVALID_REQUEST") };
  let binding: Awaited<ReturnType<typeof boundSession>>;
  try { binding = await boundSession(ctx, args); } catch (caught) { if (!(caught instanceof ConvexError)) throw caught; return { kind: "denied", error: error(codeFrom(caught)) }; }
  const { session, authority } = binding;
  const retry = Math.max(await rate(ctx, "chat-session", session._id, 5), await rate(ctx, "chat-ip", `${session.organizationId}:${args.ipKey}`, 10));
  if (retry) return { kind: "denied", error: error("RATE_LIMITED", retry) };
  const query = args.query.trim(), queryDigest = await hashOpaqueTelemetryValue(query);
  const old = await ctx.db.query("widgetTurns").withIndex("by_sessionId_and_requestId", q => q.eq("sessionId", session._id).eq("requestId", args.requestId)).unique();
  if (old) {
    if (old.queryDigest !== queryDigest) return { kind: "denied", error: error("REQUEST_CONFLICT") };
    if (old.status === "completed") {
      try { await validateGovernedCitations(ctx, [authority.store], old.citations ?? []); }
      catch { return { kind: "denied", error: error("ANSWER_UNAVAILABLE") }; }
    }
    return { kind: "existing", turn: view(old) };
  }
  const allowance = await ctx.db.query("organizationWidgetAllowances").withIndex("by_organizationId", q => q.eq("organizationId", session.organizationId)).unique();
  const now = Date.now(), date = new Date(now), dayKey = date.toISOString().slice(0, 10), monthKey = dayKey.slice(0, 7);
  const day = await ctx.db.query("widgetUsageBuckets").withIndex("by_organizationId_and_bucket", q => q.eq("organizationId", session.organizationId).eq("bucket", dayKey)).unique();
  const month = await ctx.db.query("widgetUsageBuckets").withIndex("by_organizationId_and_bucket", q => q.eq("organizationId", session.organizationId).eq("bucket", monthKey)).unique();
  const daily = Math.min(allowance?.dailyLimit ?? 0, allowance?.platformDailyLimit ?? 0), monthly = Math.min(allowance?.monthlyLimit ?? 0, allowance?.platformMonthlyLimit ?? 0);
  if ((day?.count ?? 0) >= daily || (month?.count ?? 0) >= monthly) {
    const reset = (month?.count ?? 0) >= monthly ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) : Date.parse(`${dayKey}T00:00:00Z`) + 86400000;
    return { kind: "denied", error: error("ALLOWANCE_EXHAUSTED", (reset - now) / 1000) };
  }
  const slots = await ctx.db.query("widgetTurns").withIndex("by_organizationId_and_holdsSlot_and_leaseExpiresAt", q => q.eq("organizationId", session.organizationId).eq("holdsSlot", true).gt("leaseExpiresAt", now)).take((allowance?.maxConcurrent ?? 3) + 1);
  if (slots.length >= (allowance?.maxConcurrent ?? 3) || slots.some(turn => turn.sessionId === session._id)) return { kind: "denied", error: error("GENERATION_BUSY", (Math.min(...slots.map(t => t.leaseExpiresAt)) - now) / 1000) };
  const history = await ctx.db.query("widgetTurns").withIndex("by_sessionId_and_status_and_createdAt", q => q.eq("sessionId", session._id).eq("status", "completed")).order("desc").take(WIDGET_LIMITS.historyPairs);
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  let bytes = 0;
  for (const turn of history) {
    if (!turn.result) continue;
    const pairBytes = encoder.encode(turn.query).length + encoder.encode(turn.result.answer).length;
    if (bytes + pairBytes > WIDGET_LIMITS.historyBytes) break;
    bytes += pairBytes;
    messages.unshift({ role: "user", content: turn.query }, { role: "assistant", content: turn.result.answer });
  }
  const attemptNonce = crypto.randomUUID();
  const turnId = await ctx.db.insert("widgetTurns", { sessionId: session._id, organizationId: session.organizationId, requestId: args.requestId, queryDigest, query, contentRevision: authority.contentRevision, attemptNonce, status: "pending", holdsSlot: true, leaseExpiresAt: now + WIDGET_LIMITS.leaseMs, createdAt: now, deleteAfter: session.deleteAfter });
  for (const [row, bucket] of [[day, dayKey], [month, monthKey]] as const) {
    if (row) await ctx.db.patch(row._id, { count: row.count + 1 });
    else await ctx.db.insert("widgetUsageBuckets", { organizationId: session.organizationId, bucket, count: 1, expiresAt: now + 90 * 86400000 });
  }
  await ctx.db.patch(session._id, { lastUsedAt: now, expiresAt: Math.min(now + WIDGET_LIMITS.idleMs, session.deleteAfter) });
  return { kind: "admitted", turnId, attemptNonce, authority: { organizationId: authority.organizationId, jurisdictionId: authority.jurisdictionId, accessVersion: authority.accessVersion, contentRevision: authority.contentRevision, store: authority.store }, messages };
} });

export const finishTurn = internalMutation({ args: { turnId: v.id("widgetTurns"), attemptNonce: v.string(), outcome: v.union(v.literal("completed"), v.literal("failed"), v.literal("aborted")), answer: v.optional(v.string()), citations: v.array(widgetCitationIdentityValidator), error: v.optional(widgetErrorValidator), providerFinished: v.boolean() }, handler: async (ctx, args): Promise<WidgetTurnView> => {
  const turn = await ctx.db.get(args.turnId);
  if (!turn || turn.attemptNonce !== args.attemptNonce) throw new ConvexError("INVALID_REQUEST");
  if (turn.status !== "pending") {
    if (turn.status === "completed" && args.outcome === "completed" && (args.answer !== turn.result?.answer || JSON.stringify(args.citations) !== JSON.stringify(turn.citations))) throw new ConvexError("REQUEST_CONFLICT");
    if (args.providerFinished && turn.holdsSlot) await ctx.db.patch(turn._id, { holdsSlot: false });
    // A replay is acknowledgement only. Recovery performs current access checks.
    return { requestId: turn.requestId, status: turn.status, ...(turn.error ? { error: turn.error } : {}) };
  }
  let failure: WidgetError | undefined;
  let citations: WidgetSource[] = [];
  const session = await ctx.db.get(turn.sessionId);
  const widget = session ? await ctx.db.get(session.widgetId) : null;
  try {
    if (!session || !widget) throw new ConvexError("SESSION_INVALID");
    const { authority } = await boundSession(ctx, { publicId: widget.publicId, tokenHash: session.tokenHash });
    if (turn.leaseExpiresAt <= Date.now()) failure = error("GENERATION_TIMEOUT");
    if (args.outcome === "completed" && !failure) {
      if (!args.answer?.trim() || encoder.encode(args.answer).length > 65536 || (!args.citations.length && args.answer !== CHAT_NO_EVIDENCE)) throw new ConvexError("INVALID_CHAT_CITATIONS");
      const publicCitations = await validateGovernedCitations(ctx, [authority.store], args.citations);
      citations = await Promise.all(publicCitations.map(async (citation, i) => {
        const resourceId = ctx.db.normalizeId("legalResources", args.citations[i].resourceId);
        const resource = resourceId ? await ctx.db.get(resourceId) : null;
        const versionId = ctx.db.normalizeId("documentVersions", args.citations[i].versionId);
        const version = versionId ? await ctx.db.get(versionId) : null;
        if (!resource || !version) throw new ConvexError("INVALID_CHAT_CITATIONS");
        return { ...citation, jurisdictionKind: "organizational" as const, relation: "selected" as const, issuer: resource.issuer, officialCitation: resource.officialCitation, effectiveDate: version.effectiveDate ?? resource.effectiveDate ?? null, sourceUrl: version.sourceUrl || resource.sourceUrl || null };
      }));
    }
  } catch (caught) { if (!(caught instanceof ConvexError)) throw caught; failure = error(String(caught.data) === "INVALID_CHAT_CITATIONS" ? "ANSWER_UNAVAILABLE" : codeFrom(caught)); }
  const status = failure ? "failed" : args.outcome;
  const result = status === "completed" ? { requestId: turn.requestId, answer: args.answer!, citations, completedAt: Date.now() } : undefined;
  const terminalError = failure ?? (status === "failed" ? args.error ?? error("ANSWER_UNAVAILABLE") : undefined);
  await ctx.db.patch(turn._id, { status, result, citations: result ? args.citations : undefined, error: terminalError, completedAt: Date.now(), holdsSlot: !args.providerFinished });
  return { requestId: turn.requestId, status, ...(result ? { result } : {}), ...(terminalError ? { error: terminalError } : {}) };
} });
export const readTurn = internalMutation({ args: turnArgs, handler: async (ctx, args) => {
  try {
    const { session, authority } = await boundSession(ctx, args);
    if (!validWidgetRequestId(args.requestId)) return { error: error("INVALID_REQUEST") };
    const retry = await rate(ctx, "recovery", session._id, 12);
    if (retry) return { error: error("RATE_LIMITED", retry) };
    const turn = await ctx.db.query("widgetTurns").withIndex("by_sessionId_and_requestId", q => q.eq("sessionId", session._id).eq("requestId", args.requestId)).unique();
    if (!turn) return { error: error("TURN_NOT_FOUND") };
    if (turn.status === "completed") await validateGovernedCitations(ctx, [authority.store], turn.citations ?? []);
    if (turn.status === "pending" && turn.leaseExpiresAt <= Date.now()) {
      const failure = error("GENERATION_TIMEOUT");
      await ctx.db.patch(turn._id, { status: "failed", error: failure, holdsSlot: false, completedAt: Date.now() });
      return { requestId: turn.requestId, status: "failed" as const, error: failure };
    }
    return view(turn);
  } catch (caught) { if (!(caught instanceof ConvexError)) throw caught; return { error: error(codeFrom(caught)) }; }
} });
export const cancelTurn = internalMutation({ args: turnArgs, handler: async (ctx, args) => {
  try {
    const { session, authority } = await boundSession(ctx, args);
    if (!validWidgetRequestId(args.requestId)) return { error: error("INVALID_REQUEST") };
    const turn = await ctx.db.query("widgetTurns").withIndex("by_sessionId_and_requestId", q => q.eq("sessionId", session._id).eq("requestId", args.requestId)).unique();
    if (!turn) return { error: error("TURN_NOT_FOUND") };
    if (turn.status === "completed") await validateGovernedCitations(ctx, [authority.store], turn.citations ?? []);
    if (turn.status !== "pending") return view(turn);
    await ctx.db.patch(turn._id, { status: "aborted", completedAt: Date.now() });
    return { requestId: turn.requestId, status: "aborted" as const };
  } catch (caught) { if (!(caught instanceof ConvexError)) throw caught; return { error: error(codeFrom(caught)) }; }
} });
export const revokeSession = internalMutation({ args: sessionArgs, returns: v.null(), handler: async (ctx, args) => {
  const session = await ctx.db.query("widgetSessions").withIndex("by_tokenHash", q => q.eq("tokenHash", args.tokenHash)).unique();
  const widget = session ? await ctx.db.get(session.widgetId) : null;
  if (session && widget?.publicId === args.publicId && session.revokedAt === undefined) await ctx.db.patch(session._id, { revokedAt: Date.now() });
  return null;
} });
export const cleanup = internalMutation({ args: { table: v.union(v.literal("sessions"), v.literal("turns"), v.literal("rates"), v.literal("usage")) }, handler: async (ctx, args) => {
  const now = Date.now();
  const rows = args.table === "sessions" ? await ctx.db.query("widgetSessions").withIndex("by_deleteAfter", q => q.lte("deleteAfter", now)).take(100)
    : args.table === "turns" ? await ctx.db.query("widgetTurns").withIndex("by_deleteAfter", q => q.lte("deleteAfter", now)).take(100)
    : args.table === "rates" ? await ctx.db.query("widgetRateBuckets").withIndex("by_expiresAt", q => q.lte("expiresAt", now)).take(100)
    : await ctx.db.query("widgetUsageBuckets").withIndex("by_expiresAt", q => q.lte("expiresAt", now)).take(100);
  for (const row of rows) await ctx.db.delete(row._id);
  if (rows.length === 100) await ctx.scheduler.runAfter(0, cleanupRef, args);
  return { deleted: rows.length, remaining: rows.length === 100 };
} });
