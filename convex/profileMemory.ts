import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { optionalUserId, requireUserId } from "./lib/requireUser";
import {
  profileFactTypeValidator,
  profileObservationValidator,
} from "./lib/profileMemoryContracts";
import {
  PROFILE_FACT_CATALOG,
  PROFILE_FACT_CONFLICTS,
  PROFILE_MEMORY_LIMITS,
  isProfileFactValue,
  quoteAppearsIn,
  toChatUserProfile,
  trimQuote,
  type ChatUserProfile,
  type ProfileFactType,
} from "../shared/profile-memory";

const PERSONAL_SCOPE = "personal";
const DELETE_BATCH_SIZE = 100;
const MAX_EVIDENCE_PER_FACT_READ = 200;

type Ctx = QueryCtx | MutationCtx;
type Scope = { scope: string; organizationId?: Id<"organizations"> };

/** The deployment switch. Off unless explicitly turned on. */
export function profileMemoryAvailable(): boolean {
  return process.env.PROFILE_MEMORY_ENABLED === "true";
}

/** Memory is on by default for each person until they pause it. */
async function memoryEnabledFor(ctx: Ctx, userId: string): Promise<boolean> {
  const settings = await ctx.db
    .query("userMemorySettings")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  return settings?.enabled ?? true;
}

/**
 * A chat in an organization's own jurisdiction learns into that organization's
 * profile, and only while the person is still an active member.
 */
async function scopeForSession(ctx: Ctx, userId: string, session: Doc<"chatSessions">): Promise<Scope | null> {
  if (!session.jurisdictionId) return { scope: PERSONAL_SCOPE };
  const jurisdiction = await ctx.db.get("jurisdictions", session.jurisdictionId);
  if (!jurisdiction) return null;
  if (!jurisdiction.organizationId) return { scope: PERSONAL_SCOPE };
  const organizationId = jurisdiction.organizationId;
  const membership = await ctx.db
    .query("organizationMemberships")
    .withIndex("by_organizationId_and_userId", (q) => q.eq("organizationId", organizationId).eq("userId", userId))
    .first();
  if (membership?.status !== "active") return null;
  return { scope: organizationId, organizationId };
}

async function confirmedFacts(ctx: Ctx, userId: string, scope: string) {
  return await ctx.db
    .query("userProfileFacts")
    .withIndex("by_userId_and_scope_and_status_and_lastSeenAt", (q) =>
      q.eq("userId", userId).eq("scope", scope).eq("status", "confirmed"))
    .order("desc")
    .take(PROFILE_MEMORY_LIMITS.maxConfirmed);
}

async function findFact(ctx: Ctx, userId: string, scope: string, type: ProfileFactType, value: string) {
  return await ctx.db
    .query("userProfileFacts")
    .withIndex("by_userId_and_scope_and_type_and_value", (q) =>
      q.eq("userId", userId).eq("scope", scope).eq("type", type).eq("value", value))
    .unique();
}

function decayTime(fact: Pick<Doc<"userProfileFacts">, "status" | "source" | "lastSeenAt">): number | undefined {
  if (fact.status === "candidate") return fact.lastSeenAt + PROFILE_MEMORY_LIMITS.candidateExpiryMs;
  if (fact.status === "confirmed" && fact.source === "implied") return fact.lastSeenAt + PROFILE_MEMORY_LIMITS.impliedDecayMs;
  return undefined;
}

function meetsPromotionRule(fact: Pick<Doc<"userProfileFacts">, "source" | "sightings" | "chatCount" | "firstSeenAt" | "lastSeenAt">): boolean {
  if (fact.source === "stated" || fact.source === "user") return true;
  return fact.sightings >= PROFILE_MEMORY_LIMITS.impliedSightings
    && fact.chatCount >= PROFILE_MEMORY_LIMITS.impliedChats
    && fact.lastSeenAt - fact.firstSeenAt >= PROFILE_MEMORY_LIMITS.impliedSpanMs;
}

/** Values that a newly confirmed fact replaces, demoted rather than deleted. */
async function demoteConflicts(ctx: MutationCtx, fact: Doc<"userProfileFacts">, now: number) {
  const confirmed = await confirmedFacts(ctx, fact.userId, fact.scope);
  const conflicts = PROFILE_FACT_CONFLICTS[`${fact.type}:${fact.value}`] ?? [];
  const single = !PROFILE_FACT_CATALOG[fact.type].multiple;
  for (const other of confirmed) {
    if (other._id === fact._id || other.type !== fact.type) continue;
    if (!single && !conflicts.includes(other.value)) continue;
    // A person can only overrule their own words; an older implied guess never
    // demotes something they stated or added.
    if (other.source !== "implied" && fact.source === "implied") continue;
    await ctx.db.patch(other._id, {
      status: "candidate",
      confirmedAt: undefined,
      decaysAt: other.lastSeenAt + PROFILE_MEMORY_LIMITS.candidateExpiryMs,
      updatedAt: now,
    });
  }
}

/** Confirms a fact when it clears the rule and there is room for it. */
async function maybePromote(ctx: MutationCtx, fact: Doc<"userProfileFacts">, now: number) {
  if (fact.status !== "candidate" || !meetsPromotionRule(fact)) return;
  if (fact.source === "implied") {
    // An implied value never overrides a single-valued fact the person stated.
    const confirmed = await confirmedFacts(ctx, fact.userId, fact.scope);
    const conflicts = PROFILE_FACT_CONFLICTS[`${fact.type}:${fact.value}`] ?? [];
    const blocked = confirmed.some((other) => other.type === fact.type && other.source !== "implied"
      && (!PROFILE_FACT_CATALOG[fact.type].multiple || conflicts.includes(other.value)));
    if (blocked) return;
  }
  await demoteConflicts(ctx, fact, now);
  const confirmed = await confirmedFacts(ctx, fact.userId, fact.scope);
  if (confirmed.length >= PROFILE_MEMORY_LIMITS.maxConfirmed) return;
  await ctx.db.patch(fact._id, {
    status: "confirmed",
    confirmedAt: now,
    decaysAt: decayTime({ ...fact, status: "confirmed" }),
    updatedAt: now,
  });
}

async function deleteFactWithEvidence(ctx: MutationCtx, factId: Id<"userProfileFacts">) {
  const evidence = await ctx.db
    .query("userProfileEvidence")
    .withIndex("by_factId_and_sessionId", (q) => q.eq("factId", factId))
    .take(MAX_EVIDENCE_PER_FACT_READ);
  for (const row of evidence) await ctx.db.delete(row._id);
  await ctx.db.delete(factId);
}

/** Drops the stalest candidates so one scope never holds more than the cap. */
async function trimCandidates(ctx: MutationCtx, userId: string, scope: string) {
  const candidates = await ctx.db
    .query("userProfileFacts")
    .withIndex("by_userId_and_scope_and_status_and_lastSeenAt", (q) =>
      q.eq("userId", userId).eq("scope", scope).eq("status", "candidate"))
    .order("desc")
    .take(PROFILE_MEMORY_LIMITS.maxCandidates + 5);
  for (const stale of candidates.slice(PROFILE_MEMORY_LIMITS.maxCandidates)) {
    await deleteFactWithEvidence(ctx, stale._id);
  }
}

/**
 * Called from the chat append path once a question has a saved legal answer.
 * Schedules extraction only when everything allows it; never throws.
 */
export async function scheduleProfileExtraction(
  ctx: MutationCtx,
  args: { userId: string; session: Doc<"chatSessions">; messageId: Id<"messages">; question: string },
) {
  if (!profileMemoryAvailable() || args.session.memoryDisabled) return;
  const length = args.question.trim().length;
  if (length < PROFILE_MEMORY_LIMITS.minQuestionLength || length > PROFILE_MEMORY_LIMITS.maxQuestionLength) return;
  if (!(await memoryEnabledFor(ctx, args.userId))) return;
  await ctx.scheduler.runAfter(0, internal.profileMemoryActions.extract, { messageId: args.messageId });
}

async function loadExtractionContext(ctx: Ctx, messageId: Id<"messages">) {
  if (!profileMemoryAvailable()) return null;
  const message = await ctx.db.get("messages", messageId);
  if (!message || message.role !== "user") return null;
  const session = await ctx.db.get("chatSessions", message.sessionId);
  if (!session || session.memoryDisabled) return null;
  if (!(await memoryEnabledFor(ctx, session.userId))) return null;
  const scope = await scopeForSession(ctx, session.userId, session);
  if (!scope) return null;
  return { message, session, scope };
}

export const extractionInput = internalQuery({
  args: { messageId: v.id("messages") },
  returns: v.union(v.null(), v.object({ question: v.string() })),
  handler: async (ctx, args) => {
    const context = await loadExtractionContext(ctx, args.messageId);
    return context ? { question: context.message.content } : null;
  },
});

export const recordObservations = internalMutation({
  args: { messageId: v.id("messages"), observations: v.array(profileObservationValidator) },
  returns: v.object({ recorded: v.number() }),
  handler: async (ctx, args) => {
    // Everything is checked again here: the person may have paused memory,
    // deleted the chat or left the organization while the model ran.
    const context = await loadExtractionContext(ctx, args.messageId);
    if (!context) return { recorded: 0 };
    const { message, session, scope } = context;
    const now = Date.now();
    let recorded = 0;
    const seen = new Set<string>();
    for (const observation of args.observations.slice(0, PROFILE_MEMORY_LIMITS.maxObservationsPerQuestion)) {
      const key = `${observation.type}:${observation.value}`;
      if (seen.has(key) || !isProfileFactValue(observation.type, observation.value)) continue;
      // A recurring topic is always a pattern, never a statement.
      if (observation.type === "topic" && observation.kind !== "implied") continue;
      if (!quoteAppearsIn(message.content, observation.quote)) continue;
      seen.add(key);

      let fact = await findFact(ctx, session.userId, scope.scope, observation.type, observation.value);
      if (fact?.status === "dismissed") continue;
      if (!fact) {
        const factId = await ctx.db.insert("userProfileFacts", {
          userId: session.userId,
          scope: scope.scope,
          ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
          type: observation.type,
          value: observation.value,
          status: "candidate",
          source: observation.kind,
          sightings: 0,
          chatCount: 0,
          firstSeenAt: now,
          lastSeenAt: now,
          updatedAt: now,
        });
        fact = (await ctx.db.get("userProfileFacts", factId))!;
      }
      const duplicate = await ctx.db
        .query("userProfileEvidence")
        .withIndex("by_messageId_and_factId", (q) => q.eq("messageId", message._id).eq("factId", fact!._id))
        .first();
      if (duplicate) continue;
      const sameChat = await ctx.db
        .query("userProfileEvidence")
        .withIndex("by_factId_and_sessionId", (q) => q.eq("factId", fact!._id).eq("sessionId", session._id))
        .first();
      await ctx.db.insert("userProfileEvidence", {
        userId: session.userId,
        factId: fact._id,
        sessionId: session._id,
        messageId: message._id,
        kind: observation.kind,
        createdAt: now,
      });
      const source = fact.source === "user" ? "user" : observation.kind === "stated" ? "stated" : fact.source;
      const updated = {
        ...fact,
        source,
        sightings: fact.sightings + 1,
        chatCount: fact.chatCount + (sameChat ? 0 : 1),
        lastSeenAt: now,
        quote: trimQuote(observation.quote),
      } as Doc<"userProfileFacts">;
      await ctx.db.patch(fact._id, {
        source: updated.source,
        sightings: updated.sightings,
        chatCount: updated.chatCount,
        lastSeenAt: now,
        quote: updated.quote,
        decaysAt: decayTime(updated),
        updatedAt: now,
      });
      await maybePromote(ctx, updated, now);
      recorded += 1;
    }
    if (recorded) await trimCandidates(ctx, session.userId, scope.scope);
    return { recorded };
  },
});

// ---------------------------------------------------------------------------
// Reading the profile for an answer

const chatUserProfileValidator = v.object({
  role: v.optional(v.array(v.string())),
  expertise: v.optional(v.array(v.string())),
  sector: v.optional(v.array(v.string())),
  topic: v.optional(v.array(v.string())),
  answer_preference: v.optional(v.array(v.string())),
});

/**
 * The confirmed facts the answer model may see for one chat: the personal
 * profile plus, in an organization's chat, that organization's profile.
 */
export const forChat = query({
  args: { externalId: v.string() },
  returns: v.union(v.null(), chatUserProfileValidator),
  handler: async (ctx, args): Promise<ChatUserProfile | null> => {
    if (!profileMemoryAvailable()) return null;
    const userId = await optionalUserId(ctx);
    if (!userId || !(await memoryEnabledFor(ctx, userId))) return null;
    const session = await ctx.db
      .query("chatSessions")
      .withIndex("by_user_externalId", (q) => q.eq("userId", userId).eq("externalId", args.externalId))
      .unique();
    if (session?.memoryDisabled) return null;
    const scope = session ? await scopeForSession(ctx, userId, session) : { scope: PERSONAL_SCOPE };
    const facts = await confirmedFacts(ctx, userId, PERSONAL_SCOPE);
    if (scope && scope.scope !== PERSONAL_SCOPE) facts.push(...await confirmedFacts(ctx, userId, scope.scope));
    return toChatUserProfile(facts) ?? null;
  },
});

// ---------------------------------------------------------------------------
// The person's controls (Settings > Memory)

const factViewValidator = v.object({
  id: v.id("userProfileFacts"),
  type: profileFactTypeValidator,
  value: v.string(),
  source: v.union(v.literal("stated"), v.literal("implied"), v.literal("user")),
  quote: v.optional(v.string()),
  confirmedAt: v.optional(v.number()),
});

export const overview = query({
  args: {},
  returns: v.union(v.null(), v.object({
    available: v.boolean(),
    enabled: v.boolean(),
    scopes: v.array(v.object({
      scope: v.string(),
      organizationId: v.optional(v.id("organizations")),
      name: v.string(),
      facts: v.array(factViewValidator),
    })),
  })),
  handler: async (ctx) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return null;
    const enabled = await memoryEnabledFor(ctx, userId);
    const scopes: Array<{ scope: string; organizationId?: Id<"organizations">; name: string; facts: Array<Doc<"userProfileFacts">> }> = [
      { scope: PERSONAL_SCOPE, name: "Personal", facts: await confirmedFacts(ctx, userId, PERSONAL_SCOPE) },
    ];
    const memberships = await ctx.db
      .query("organizationMemberships")
      .withIndex("by_userId_and_status", (q) => q.eq("userId", userId).eq("status", "active"))
      .take(20);
    for (const membership of memberships) {
      const organization = await ctx.db.get("organizations", membership.organizationId);
      if (!organization) continue;
      scopes.push({
        scope: membership.organizationId,
        organizationId: membership.organizationId,
        name: organization.name,
        facts: await confirmedFacts(ctx, userId, membership.organizationId),
      });
    }
    return {
      available: profileMemoryAvailable(),
      enabled,
      scopes: scopes.map(({ facts, ...scope }) => ({
        ...scope,
        facts: facts.map((fact) => ({
          id: fact._id,
          type: fact.type,
          value: fact.value,
          source: fact.source,
          ...(fact.quote ? { quote: fact.quote } : {}),
          ...(fact.confirmedAt ? { confirmedAt: fact.confirmedAt } : {}),
        })),
      })),
    };
  },
});

export const setEnabled = mutation({
  args: { enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const existing = await ctx.db
      .query("userMemorySettings")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (existing) await ctx.db.patch(existing._id, { enabled: args.enabled, updatedAt: Date.now() });
    else await ctx.db.insert("userMemorySettings", { userId, enabled: args.enabled, updatedAt: Date.now() });
    return null;
  },
});

async function scopeForUser(ctx: MutationCtx, userId: string, organizationId?: Id<"organizations">): Promise<Scope> {
  if (!organizationId) return { scope: PERSONAL_SCOPE };
  const membership = await ctx.db
    .query("organizationMemberships")
    .withIndex("by_organizationId_and_userId", (q) => q.eq("organizationId", organizationId).eq("userId", userId))
    .first();
  if (membership?.status !== "active") throw new ConvexError("PROFILE_MEMORY_SCOPE_UNAVAILABLE");
  return { scope: organizationId, organizationId };
}

/** "Remember this" from Settings: the person's own words, confirmed at once. */
export const addFact = mutation({
  args: { type: profileFactTypeValidator, value: v.string(), organizationId: v.optional(v.id("organizations")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    if (!isProfileFactValue(args.type, args.value)) throw new ConvexError("PROFILE_MEMORY_VALUE_INVALID");
    const scope = await scopeForUser(ctx, userId, args.organizationId);
    const now = Date.now();
    const existing = await findFact(ctx, userId, scope.scope, args.type, args.value);
    const confirmed = await confirmedFacts(ctx, userId, scope.scope);
    if (existing?.status !== "confirmed" && confirmed.length >= PROFILE_MEMORY_LIMITS.maxConfirmed) {
      throw new ConvexError("PROFILE_MEMORY_FULL");
    }
    let fact: Doc<"userProfileFacts">;
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: "confirmed", source: "user", confirmedAt: existing.confirmedAt ?? now,
        decaysAt: undefined, quote: undefined, lastSeenAt: now, updatedAt: now,
      });
      fact = (await ctx.db.get("userProfileFacts", existing._id))!;
    } else {
      const id = await ctx.db.insert("userProfileFacts", {
        userId, scope: scope.scope, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
        type: args.type, value: args.value, status: "confirmed", source: "user",
        sightings: 0, chatCount: 0, firstSeenAt: now, lastSeenAt: now, confirmedAt: now, updatedAt: now,
      });
      fact = (await ctx.db.get("userProfileFacts", id))!;
    }
    await demoteConflicts(ctx, fact, now);
    return null;
  },
});

/** Removes a fact and its evidence. The row stays as "dismissed" so it is never learned again. */
export const removeFact = mutation({
  args: { factId: v.id("userProfileFacts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const fact = await ctx.db.get("userProfileFacts", args.factId);
    if (!fact || fact.userId !== userId) return null;
    const evidence = await ctx.db
      .query("userProfileEvidence")
      .withIndex("by_factId_and_sessionId", (q) => q.eq("factId", fact._id))
      .take(MAX_EVIDENCE_PER_FACT_READ);
    for (const row of evidence) await ctx.db.delete(row._id);
    await ctx.db.patch(fact._id, {
      status: "dismissed", confirmedAt: undefined, decaysAt: undefined, quote: undefined,
      sightings: 0, chatCount: 0, updatedAt: Date.now(),
    });
    return null;
  },
});

/** Forgets everything, including removed facts, so memory starts fresh. */
export const clearAll = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    await ctx.scheduler.runAfter(0, internal.profileMemory.deleteAllForUserBatch, { userId });
    return null;
  },
});

export const setChatMemory = mutation({
  args: { externalId: v.string(), disabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const session = await ctx.db
      .query("chatSessions")
      .withIndex("by_user_externalId", (q) => q.eq("userId", userId).eq("externalId", args.externalId))
      .unique();
    if (!session) throw new ConvexError("CHAT_NOT_FOUND");
    await ctx.db.patch(session._id, { memoryDisabled: args.disabled ? true : undefined });
    if (args.disabled) {
      // Turning memory off for a chat also forgets what that chat taught.
      await ctx.scheduler.runAfter(0, internal.profileMemory.deleteEvidenceForSessionBatch, { sessionId: session._id });
    }
    return null;
  },
});

export const chatMemory = query({
  args: { externalId: v.string() },
  returns: v.union(v.null(), v.object({ available: v.boolean(), enabled: v.boolean(), disabledForChat: v.boolean() })),
  handler: async (ctx, args) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return null;
    const session = await ctx.db
      .query("chatSessions")
      .withIndex("by_user_externalId", (q) => q.eq("userId", userId).eq("externalId", args.externalId))
      .unique();
    return {
      available: profileMemoryAvailable(),
      enabled: await memoryEnabledFor(ctx, userId),
      disabledForChat: session?.memoryDisabled === true,
    };
  },
});

// ---------------------------------------------------------------------------
// Clean-up

export const deleteAllForUserBatch = internalMutation({
  args: { userId: v.string() },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const evidence = await ctx.db
      .query("userProfileEvidence")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .take(DELETE_BATCH_SIZE);
    for (const row of evidence) await ctx.db.delete(row._id);
    const facts = evidence.length < DELETE_BATCH_SIZE ? await ctx.db
      .query("userProfileFacts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .take(DELETE_BATCH_SIZE) : [];
    for (const row of facts) await ctx.db.delete(row._id);
    const hasMore = evidence.length === DELETE_BATCH_SIZE || facts.length === DELETE_BATCH_SIZE;
    if (hasMore) await ctx.scheduler.runAfter(0, internal.profileMemory.deleteAllForUserBatch, args);
    return { hasMore };
  },
});

/** Recounts a fact from its remaining evidence after some of it was deleted. */
async function recountFact(ctx: MutationCtx, factId: Id<"userProfileFacts">, now: number) {
  const fact = await ctx.db.get("userProfileFacts", factId);
  if (!fact || fact.status === "dismissed") return;
  const remaining = await ctx.db
    .query("userProfileEvidence")
    .withIndex("by_factId_and_sessionId", (q) => q.eq("factId", factId))
    .take(MAX_EVIDENCE_PER_FACT_READ);
  if (fact.source !== "user" && remaining.length === 0) {
    await ctx.db.delete(factId);
    return;
  }
  if (fact.source === "user") return;
  const chats = new Set(remaining.map((row) => row.sessionId));
  const times = remaining.map((row) => row.createdAt);
  const recounted = {
    ...fact,
    source: remaining.some((row) => row.kind === "stated") ? "stated" as const : "implied" as const,
    sightings: remaining.length,
    chatCount: chats.size,
    firstSeenAt: Math.min(...times),
    lastSeenAt: Math.max(...times),
  };
  const status = fact.status === "confirmed" && !meetsPromotionRule(recounted) ? "candidate" as const : fact.status;
  await ctx.db.patch(factId, {
    source: recounted.source,
    sightings: recounted.sightings,
    chatCount: recounted.chatCount,
    firstSeenAt: recounted.firstSeenAt,
    lastSeenAt: recounted.lastSeenAt,
    status,
    ...(status === "candidate" ? { confirmedAt: undefined } : {}),
    decaysAt: decayTime({ ...recounted, status }),
    updatedAt: now,
  });
}

/** Deleting a chat (or turning memory off for it) deletes what it taught. */
export const deleteEvidenceForSessionBatch = internalMutation({
  args: { sessionId: v.id("chatSessions") },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const evidence = await ctx.db
      .query("userProfileEvidence")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .take(DELETE_BATCH_SIZE);
    const factIds = new Set<Id<"userProfileFacts">>();
    for (const row of evidence) {
      factIds.add(row.factId);
      await ctx.db.delete(row._id);
    }
    const now = Date.now();
    for (const factId of factIds) await recountFact(ctx, factId, now);
    const hasMore = evidence.length === DELETE_BATCH_SIZE;
    if (hasMore) await ctx.scheduler.runAfter(0, internal.profileMemory.deleteEvidenceForSessionBatch, args);
    return { hasMore };
  },
});

/** Candidates expire; implied facts that stop showing up go back to being candidates. */
export const decayBatch = internalMutation({
  args: {},
  returns: v.object({ processed: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("userProfileFacts")
      .withIndex("by_decaysAt", (q) => q.gte("decaysAt", 0).lt("decaysAt", now))
      .take(DELETE_BATCH_SIZE);
    for (const fact of due) {
      if (fact.status === "candidate") {
        await deleteFactWithEvidence(ctx, fact._id);
      } else if (fact.status === "confirmed" && fact.source === "implied") {
        await ctx.db.patch(fact._id, {
          status: "candidate",
          confirmedAt: undefined,
          decaysAt: now + PROFILE_MEMORY_LIMITS.candidateExpiryMs,
          updatedAt: now,
        });
      } else {
        await ctx.db.patch(fact._id, { decaysAt: undefined, updatedAt: now });
      }
    }
    if (due.length === DELETE_BATCH_SIZE) await ctx.scheduler.runAfter(0, internal.profileMemory.decayBatch, {});
    return { processed: due.length };
  },
});
