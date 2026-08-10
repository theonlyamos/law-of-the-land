import { makeFunctionReference, paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { components, internal } from "./_generated/api";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { optionalUserId, requireUserId } from "./lib/requireUser";
import {
  chatCitationValidator,
  allowedParentLevelsByLevel,
  isLegacyCountryCode,
  jurisdictionKindValidator,
  MAX_GEOGRAPHIC_DEPTH,
  type JurisdictionKind,
} from "./lib/jurisdictionDomain";
import {
  activeOrganizationIdsForUser,
  assertJurisdictionAccess,
} from "./lib/jurisdictionAccess";
import { readUnifiedJurisdictionsEnabled } from "./admin/featureFlags";
import {
  citationClaimIssueProofParts,
  createCitationClaimBindings,
  isCitationClaimBinding,
  type ClaimCitation,
} from "./lib/chatCitationClaim";
import {
  createOpaqueTelemetryToken,
  createTelemetryPrincipalBinding,
  hashOpaqueTelemetryValue,
  isOpaqueTelemetryToken,
  verifyTelemetryServiceProof,
} from "./lib/telemetryProof";

const messageValidator = v.union(
  v.object({
    role: v.literal("user"),
    content: v.string(),
    clientId: v.optional(v.string()),
    createdAt: v.optional(v.number()),
  }),
  v.object({
    role: v.literal("assistant"),
    content: v.string(),
    clientId: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    citations: v.optional(v.array(chatCitationValidator)),
    citationClaim: v.optional(v.string()),
  }),
);

const legacyLocalMessageValidator = v.union(
  v.object({
    role: v.literal("user"),
    content: v.string(),
    clientId: v.optional(v.string()),
    createdAt: v.optional(v.number()),
  }),
  v.object({
    role: v.literal("assistant"),
    content: v.string(),
    clientId: v.optional(v.string()),
    createdAt: v.optional(v.number()),
  }),
);

const MAX_SESSION_PAGE_SIZE = 30;
const MAX_MESSAGE_PAGE_SIZE = 50;
const DELETE_BATCH_SIZE = 100;
const MAX_CITATIONS = 16;
const MAX_CITATION_LABEL_LENGTH = 200;
const MAX_ORGANIZATION_SCOPE_LINKS = 8;
const CITATION_CLAIM_TTL_MS = 2 * 60_000;
const MAX_CHAT_EXTERNAL_ID_LENGTH = 200;
const MAX_ASSISTANT_CLIENT_ID_LENGTH = 200;
const MAX_ASSISTANT_CONTENT_LENGTH = 32_000;
const expireCitationClaimRef = makeFunctionReference<"mutation">("chats:expireCitationClaim");
type ChatCtx = QueryCtx | MutationCtx;

function unavailable(): never {
  throw new ConvexError("That jurisdiction is not available for research.");
}

function invalidCitationClaim(): never {
  throw new ConvexError("INVALID_CHAT_CITATION_CLAIM");
}

function opaqueEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function citationClaimPrincipal(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || typeof identity.sessionId !== "string") invalidCitationClaim();
  const authSession = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "session",
    where: [{ field: "_id", operator: "eq", value: identity.sessionId }],
  });
  if (!authSession || authSession.userId !== identity.subject) invalidCitationClaim();
  return {
    ownerBinding: await createTelemetryPrincipalBinding("owner", identity.tokenIdentifier),
    sessionBinding: await createTelemetryPrincipalBinding("session", identity.sessionId),
  };
}

async function assertTypedJurisdiction(ctx: ChatCtx, row: Doc<"jurisdictions">): Promise<JurisdictionKind> {
  const kind = row.kind;
  if (row.status !== "enabled" || (kind !== "geographic" && kind !== "organizational")) unavailable();
  const [geographicProfiles, organizationalProfiles] = await Promise.all([
    ctx.db.query("geographicJurisdictions").withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", row._id)).take(2),
    ctx.db.query("organizationalJurisdictions").withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", row._id)).take(2),
  ]);
  if (kind === "geographic") {
    if (geographicProfiles.length !== 1 || organizationalProfiles.length !== 0 || row.organizationId !== undefined) unavailable();
  } else {
    if (!row.organizationId || organizationalProfiles.length !== 1 || geographicProfiles.length !== 0) unavailable();
    const profile = organizationalProfiles[0];
    const [organization, links] = await Promise.all([
      ctx.db.get("organizations", row.organizationId),
      ctx.db.query("organizationGeographicScopes")
        .withIndex("by_organizationalJurisdictionId_and_geographicJurisdictionId", (q) => q.eq("organizationalJurisdictionId", profile._id))
        .take(MAX_ORGANIZATION_SCOPE_LINKS + 1),
    ]);
    if (!organization || organization.status !== "active") unavailable();
    if (
      links.length > MAX_ORGANIZATION_SCOPE_LINKS ||
      (profile.scopeMode === "global" && links.length !== 0) ||
      (profile.scopeMode === "linked_geographies" && links.length === 0) ||
      new Set(links.map((link) => link.geographicJurisdictionId)).size !== links.length
    ) unavailable();
    if (profile.scopeMode === "linked_geographies") {
      const validTargets = await Promise.all(links.map(async (link) => {
        const geographicProfile = await ctx.db.get("geographicJurisdictions", link.geographicJurisdictionId);
        if (!geographicProfile) return false;
        const [common, geographicRows, organizationalRows] = await Promise.all([
          ctx.db.get("jurisdictions", geographicProfile.jurisdictionId),
          ctx.db.query("geographicJurisdictions")
            .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", geographicProfile.jurisdictionId))
            .take(2),
          ctx.db.query("organizationalJurisdictions")
            .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", geographicProfile.jurisdictionId))
            .take(1),
        ]);
        return common?.status === "enabled" && common.kind === "geographic" &&
          geographicRows.length === 1 && organizationalRows.length === 0;
      }));
      if (validTargets.some((valid) => !valid)) unavailable();
    }
  }
  return kind;
}

async function historicalJurisdiction(ctx: ChatCtx, country: string): Promise<Doc<"jurisdictions"> | null> {
  const normalized = country.trim().toUpperCase();
  if (!isLegacyCountryCode(normalized)) return null;
  const rows = await ctx.db.query("jurisdictions")
    .withIndex("by_legacyCountryCode_and_status", (q) => q.eq("legacyCountryCode", normalized).eq("status", "enabled"))
    .take(2);
  return rows.length === 1 ? rows[0] : null;
}

async function sessionJurisdiction(ctx: ChatCtx, session: Doc<"chatSessions">): Promise<Doc<"jurisdictions"> | null | undefined> {
  if (session.jurisdictionId) return await ctx.db.get("jurisdictions", session.jurisdictionId);
  if (session.country) return await historicalJurisdiction(ctx, session.country);
  return undefined;
}

async function geographicProfile(
  ctx: ChatCtx,
  jurisdictionId: Id<"jurisdictions">,
): Promise<Doc<"geographicJurisdictions"> | null> {
  const rows = await ctx.db.query("geographicJurisdictions")
    .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", jurisdictionId))
    .take(2);
  return rows.length === 1 ? rows[0] : null;
}

async function actualGeographicAncestors(
  ctx: ChatCtx,
  descendantId: Id<"jurisdictions">,
): Promise<Set<Id<"jurisdictions">>> {
  let currentId = descendantId;
  const visited = new Set<Id<"jurisdictions">>([currentId]);
  const ancestors = new Set<Id<"jurisdictions">>();
  for (let depth = 0; depth < MAX_GEOGRAPHIC_DEPTH; depth += 1) {
    const current = await geographicProfile(ctx, currentId);
    const parentId = current?.parentJurisdictionId;
    if (!current || !parentId || visited.has(parentId)) return ancestors;
    const parent = await geographicProfile(ctx, parentId);
    if (!parent || !allowedParentLevelsByLevel[current.level].includes(parent.level)) return ancestors;
    const common = await ctx.db.get("jurisdictions", parentId);
    if (!common || common.kind !== "geographic" || common.status !== "enabled" ||
      (common.visibility ?? "public") !== "public") return ancestors;
    ancestors.add(parentId);
    visited.add(parentId);
    currentId = parentId;
  }
  return ancestors;
}

async function assertActualCitationRelationships(
  ctx: MutationCtx,
  session: Doc<"chatSessions">,
  citations: readonly ClaimCitation[],
) {
  if (!session.jurisdictionId) throw new ConvexError("INVALID_CHAT_CITATIONS");
  const selected = await ctx.db.get("jurisdictions", session.jurisdictionId);
  if (!selected) throw new ConvexError("INVALID_CHAT_CITATIONS");
  const selectedKind = await assertTypedJurisdiction(ctx, selected);

  let organizationProfile: Doc<"organizationalJurisdictions"> | null = null;
  let organizationLinks: Doc<"organizationGeographicScopes">[] = [];
  let allowedOrganizationalGeographies: Set<Id<"jurisdictions">> | null = null;
  let allowedAncestors = selectedKind === "geographic"
    ? await actualGeographicAncestors(ctx, selected._id)
    : new Set<Id<"jurisdictions">>();
  if (selectedKind === "organizational") {
    const profiles = await ctx.db.query("organizationalJurisdictions")
      .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", selected._id)).take(2);
    if (profiles.length !== 1) throw new ConvexError("INVALID_CHAT_CITATIONS");
    organizationProfile = profiles[0];
    organizationLinks = await ctx.db.query("organizationGeographicScopes")
      .withIndex("by_organizationalJurisdictionId_and_geographicJurisdictionId", (q) =>
        q.eq("organizationalJurisdictionId", organizationProfile!._id))
      .take(MAX_ORGANIZATION_SCOPE_LINKS + 1);
    if (organizationLinks.length > MAX_ORGANIZATION_SCOPE_LINKS) {
      throw new ConvexError("INVALID_CHAT_CITATIONS");
    }
    if (organizationProfile.scopeMode === "linked_geographies") {
      const linkedProfiles = await Promise.all(
        organizationLinks.map((link) => ctx.db.get("geographicJurisdictions", link.geographicJurisdictionId)),
      );
      if (linkedProfiles.some((profile) => profile === null)) throw new ConvexError("INVALID_CHAT_CITATIONS");
      allowedOrganizationalGeographies = new Set(linkedProfiles.map((profile) => profile!.jurisdictionId));
      const ancestorSets = await Promise.all(linkedProfiles.map((profile) =>
        actualGeographicAncestors(ctx, profile!.jurisdictionId)));
      allowedAncestors = new Set(ancestorSets.flatMap((set) => [...set]));
    }
  }

  for (const citation of citations) {
    if (citation.relation === "selected") {
      if (citation.jurisdictionId !== selected._id) throw new ConvexError("INVALID_CHAT_CITATIONS");
      continue;
    }
    if (selectedKind === "geographic") {
      if (citation.relation !== "geographic_ancestor" ||
        !allowedAncestors.has(citation.jurisdictionId as Id<"jurisdictions">)) {
        throw new ConvexError("INVALID_CHAT_CITATIONS");
      }
      continue;
    }
    if (citation.relation === "organizational_geography") {
      if (allowedOrganizationalGeographies &&
        !allowedOrganizationalGeographies.has(citation.jurisdictionId as Id<"jurisdictions">)) {
        throw new ConvexError("INVALID_CHAT_CITATIONS");
      }
      continue;
    }
    if (organizationProfile!.scopeMode === "linked_geographies" &&
      !allowedAncestors.has(citation.jurisdictionId as Id<"jurisdictions">)) {
      throw new ConvexError("INVALID_CHAT_CITATIONS");
    }
  }
}

async function canAccessSession(
  ctx: ChatCtx,
  session: Doc<"chatSessions">,
  activeOrganizationIds?: Set<Id<"organizations">> | null,
  cache?: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (cache) {
    const key = session.jurisdictionId
      ? `id:${session.jurisdictionId}:${session.jurisdictionName ?? ""}:${session.jurisdictionKind ?? ""}:${session.country ?? ""}`
      : session.country ? `code:${session.country}` : "legacy:none";
    const cached = cache.get(key);
    if (cached) return await cached;
    const pending = canAccessSession(ctx, session, activeOrganizationIds);
    cache.set(key, pending);
    return await pending;
  }
  const row = await sessionJurisdiction(ctx, session);
  if (row === undefined) return true;
  if (!row) return false;
  try {
    const kind = await assertTypedJurisdiction(ctx, row);
    if (
      session.jurisdictionId &&
      (!session.jurisdictionName || session.jurisdictionKind !== kind ||
        !session.jurisdictionName.trim())
    ) return false;
    if ((row.visibility ?? "public") === "public") return true;
    if (activeOrganizationIds !== undefined) {
      return Boolean(row.organizationId && activeOrganizationIds?.has(row.organizationId));
    }
    await assertJurisdictionAccess(ctx, row);
    return true;
  } catch {
    return false;
  }
}

function assertSelectionMatches(session: Doc<"chatSessions">, args: {
  jurisdictionId?: Id<"jurisdictions">;
  jurisdictionName?: string;
  jurisdictionKind?: JurisdictionKind;
  country?: string;
}) {
  if (args.jurisdictionId !== undefined && args.jurisdictionId !== session.jurisdictionId) unavailable();
  if (args.jurisdictionName !== undefined && args.jurisdictionName !== session.jurisdictionName) unavailable();
  if (args.jurisdictionKind !== undefined && args.jurisdictionKind !== session.jurisdictionKind) unavailable();
  if (args.country !== undefined && args.country.trim().toUpperCase() !== session.country) unavailable();
}

async function validateCitations(
  ctx: MutationCtx,
  session: Doc<"chatSessions">,
  messages: Array<{
    role: "user" | "assistant";
    citations?: Array<{
      label: string;
      jurisdictionId: Id<"jurisdictions">;
      jurisdictionName: string;
      jurisdictionKind: JurisdictionKind;
      relation: "selected" | "geographic_ancestor" | "organizational_geography";
    }>;
  }>,
) {
  for (const message of messages) {
    if (message.role !== "assistant" || message.citations === undefined) continue;
    if (!session.jurisdictionId) throw new ConvexError("INVALID_CHAT_CITATIONS");
    const keys = new Set<string>();
    if (message.citations.length > MAX_CITATIONS || message.citations.some((citation) => {
      const key = `${citation.jurisdictionId}:${citation.relation}:${citation.label}`;
      if (keys.has(key)) return true;
      keys.add(key);
      return !citation.label.trim() || citation.label.length > MAX_CITATION_LABEL_LENGTH ||
        !citation.jurisdictionName.trim() || citation.jurisdictionName.length > 200;
    })) {
      throw new ConvexError("INVALID_CHAT_CITATIONS");
    }
    for (const citation of message.citations) {
      const row = await ctx.db.get("jurisdictions", citation.jurisdictionId);
      if (!row) throw new ConvexError("INVALID_CHAT_CITATIONS");
      let kind: JurisdictionKind;
      try {
        kind = await assertTypedJurisdiction(ctx, row);
      } catch {
        throw new ConvexError("INVALID_CHAT_CITATIONS");
      }
      if (
        row.name !== citation.jurisdictionName ||
        kind !== citation.jurisdictionKind ||
        (citation.relation === "selected") !== (citation.jurisdictionId === session.jurisdictionId) ||
        (citation.relation !== "selected" &&
          (kind !== "geographic" || (row.visibility ?? "public") !== "public"))
      ) throw new ConvexError("INVALID_CHAT_CITATIONS");
    }
    await assertActualCitationRelationships(ctx, session, message.citations);
  }
}

function sameCitationSnapshots(
  stored: Doc<"messages">["citations"],
  incoming: ClaimCitation[] | undefined,
): boolean {
  if (stored === undefined || incoming === undefined) return stored === incoming;
  return stored.length === incoming.length && stored.every((citation, index) => {
    const candidate = incoming[index];
    return citation.label === candidate.label &&
      citation.jurisdictionId === candidate.jurisdictionId &&
      citation.jurisdictionName === candidate.jurisdictionName &&
      citation.jurisdictionKind === candidate.jurisdictionKind &&
      citation.relation === candidate.relation;
  });
}

function samePendingMessage(
  left: {
    role: "user" | "assistant";
    content: string;
    createdAt?: number;
    citations?: Doc<"messages">["citations"];
  },
  right: {
    role: "user" | "assistant";
    content: string;
    createdAt?: number;
    citations?: Doc<"messages">["citations"];
  },
): boolean {
  return left.role === right.role &&
    left.content === right.content &&
    (left.createdAt === undefined
      ? right.createdAt === undefined
      : right.createdAt !== undefined && Object.is(left.createdAt, right.createdAt)) &&
    sameCitationSnapshots(
      left.role === "assistant" ? left.citations : undefined,
      right.role === "assistant" ? right.citations : undefined,
    );
}

export function normalizePageSize(numItems: number, maxPageSize: number): number {
  if (!Number.isFinite(numItems) || numItems <= 0) return 1;
  return Math.min(maxPageSize, Math.max(1, Math.floor(numItems)));
}

const chatSessionSummaryValidator = v.object({
  id: v.string(),
  title: v.string(),
  lastMessage: v.string(),
  timestamp: v.number(),
  messageCount: v.number(),
});

const chatSessionMetadataValidator = v.object({
  id: v.string(),
  title: v.string(),
  lastMessage: v.string(),
  timestamp: v.number(),
  messageCount: v.number(),
  country: v.union(v.string(), v.null()),
  jurisdictionId: v.union(v.id("jurisdictions"), v.null()),
  jurisdictionName: v.union(v.string(), v.null()),
  jurisdictionKind: v.union(jurisdictionKindValidator, v.null()),
});

const chatMessageValidator = v.object({
  storageId: v.id("messages"),
  clientId: v.union(v.string(), v.null()),
  role: v.union(v.literal("user"), v.literal("assistant")),
  content: v.string(),
  createdAt: v.number(),
  creationTime: v.number(),
  citations: v.optional(v.array(chatCitationValidator)),
});

export const issueCitationClaim = mutation({
  args: {
    externalId: v.string(),
    jurisdictionId: v.string(),
    assistantClientId: v.string(),
    assistantContent: v.string(),
    citations: v.array(chatCitationValidator),
    assistantClientIdBinding: v.string(),
    assistantContentBinding: v.string(),
    orderedCitationBinding: v.string(),
    serviceProof: v.string(),
  },
  returns: v.object({ citationClaim: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    if (!args.externalId.trim() || args.externalId.length > MAX_CHAT_EXTERNAL_ID_LENGTH ||
      !args.assistantClientId.trim() || args.assistantClientId.length > MAX_ASSISTANT_CLIENT_ID_LENGTH ||
      !args.assistantContent.trim() || args.assistantContent.length > MAX_ASSISTANT_CONTENT_LENGTH ||
      args.citations.length === 0 || args.citations.length > MAX_CITATIONS) invalidCitationClaim();
    const jurisdictionId = ctx.db.normalizeId("jurisdictions", args.jurisdictionId);
    if (!jurisdictionId) invalidCitationClaim();
    const suppliedBindings = {
      assistantClientIdBinding: args.assistantClientIdBinding,
      assistantContentBinding: args.assistantContentBinding,
      orderedCitationBinding: args.orderedCitationBinding,
    };
    if (!isCitationClaimBinding(suppliedBindings.assistantClientIdBinding) ||
      !isCitationClaimBinding(suppliedBindings.assistantContentBinding) ||
      !isCitationClaimBinding(suppliedBindings.orderedCitationBinding)) {
      invalidCitationClaim();
    }
    if (!(await verifyTelemetryServiceProof(
      args.serviceProof,
      await citationClaimIssueProofParts({ externalId: args.externalId, jurisdictionId, ...suppliedBindings }),
    ))) invalidCitationClaim();
    const expectedBindings = await createCitationClaimBindings(
      args.assistantClientId,
      args.assistantContent,
      args.citations,
    );
    if (!opaqueEqual(expectedBindings.assistantClientIdBinding, suppliedBindings.assistantClientIdBinding) ||
      !opaqueEqual(expectedBindings.assistantContentBinding, suppliedBindings.assistantContentBinding) ||
      !opaqueEqual(expectedBindings.orderedCitationBinding, suppliedBindings.orderedCitationBinding)) {
      invalidCitationClaim();
    }

    const userId = await requireUserId(ctx);
    const session = await ctx.db.query("chatSessions")
      .withIndex("by_user_externalId", (q) => q.eq("userId", userId).eq("externalId", args.externalId))
      .unique();
    if (!session || session.jurisdictionId !== jurisdictionId || !(await canAccessSession(ctx, session))) {
      invalidCitationClaim();
    }
    if (!(await readUnifiedJurisdictionsEnabled(ctx))) invalidCitationClaim();
    await validateCitations(ctx, session, [{ role: "assistant", citations: args.citations }]);
    const principal = await citationClaimPrincipal(ctx);
    const citationClaim = createOpaqueTelemetryToken();
    const tokenHash = await hashOpaqueTelemetryValue(citationClaim);
    const duplicates = await ctx.db.query("chatCitationClaims")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).take(2);
    if (duplicates.length !== 0) invalidCitationClaim();
    const expiresAt = Date.now() + CITATION_CLAIM_TTL_MS;
    await ctx.db.insert("chatCitationClaims", {
      tokenHash,
      ...principal,
      chatSessionId: session._id,
      jurisdictionId,
      ...expectedBindings,
      expiresAt,
    });
    await ctx.scheduler.runAt(expiresAt, expireCitationClaimRef, { tokenHash });
    return { citationClaim, expiresAt };
  },
});

async function consumeCitationClaim(
  ctx: MutationCtx,
  session: Doc<"chatSessions">,
  message: {
    clientId?: string;
    content: string;
    citations: ClaimCitation[];
    citationClaim?: string;
  },
) {
  if (!message.clientId || !message.citationClaim || !isOpaqueTelemetryToken(message.citationClaim) ||
    !session.jurisdictionId) invalidCitationClaim();
  const tokenHash = await hashOpaqueTelemetryValue(message.citationClaim);
  const rows = await ctx.db.query("chatCitationClaims")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).take(2);
  if (rows.length !== 1 || Date.now() >= rows[0].expiresAt) invalidCitationClaim();
  const principal = await citationClaimPrincipal(ctx);
  const bindings = await createCitationClaimBindings(message.clientId, message.content, message.citations);
  const row = rows[0];
  if (row.chatSessionId !== session._id || row.jurisdictionId !== session.jurisdictionId ||
    !opaqueEqual(row.ownerBinding, principal.ownerBinding) ||
    !opaqueEqual(row.sessionBinding, principal.sessionBinding) ||
    !opaqueEqual(row.assistantClientIdBinding, bindings.assistantClientIdBinding) ||
    !opaqueEqual(row.assistantContentBinding, bindings.assistantContentBinding) ||
    !opaqueEqual(row.orderedCitationBinding, bindings.orderedCitationBinding)) {
    invalidCitationClaim();
  }
  await ctx.db.delete(row._id);
}

export const expireCitationClaim = internalMutation({
  args: { tokenHash: v.string() },
  returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("chatCitationClaims")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash)).take(2);
    if (rows.length !== 1 || Date.now() < rows[0].expiresAt) return { deleted: false };
    await ctx.db.delete(rows[0]._id);
    return { deleted: true };
  },
});

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(chatSessionSummaryValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };

    const result = await ctx.db
      .query("chatSessions")
      .withIndex("by_userId_and_updatedAt", (q) => q.eq("userId", userId))
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: normalizePageSize(args.paginationOpts.numItems, MAX_SESSION_PAGE_SIZE),
      });

    let visible = result.page;
    const unified = await readUnifiedJurisdictionsEnabled(ctx);
    if (unified || result.page.some((session) => session.jurisdictionId !== undefined)) {
      let memberships: Set<Id<"organizations">> | null = null;
      try { memberships = await activeOrganizationIdsForUser(ctx, userId); } catch { memberships = null; }
      const cache = new Map<string, Promise<boolean>>();
      const access = await Promise.all(result.page.map((session) =>
        unified || session.jurisdictionId
          ? canAccessSession(ctx, session, memberships, cache)
          : Promise.resolve(true)));
      visible = result.page.filter((_, index) => access[index]);
    }
    return {
      page: visible.map((session) => ({
        id: session.externalId,
        title: session.title,
        lastMessage: session.lastMessage,
        timestamp: session.updatedAt,
        messageCount: session.messageCount,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const getByExternalId = query({
  args: {
    externalId: v.string(),
  },
  returns: v.union(chatSessionMetadataValidator, v.null()),
  handler: async (ctx, args) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return null;

    const session = await ctx.db
      .query("chatSessions")
      .withIndex("by_user_externalId", (q) =>
        q.eq("userId", userId).eq("externalId", args.externalId)
      )
      .unique();

    if (!session) return null;
    if ((session.jurisdictionId || await readUnifiedJurisdictionsEnabled(ctx)) &&
      !(await canAccessSession(ctx, session))) return null;

    return {
      id: session.externalId,
      title: session.title,
      lastMessage: session.lastMessage,
      timestamp: session.updatedAt,
      messageCount: session.messageCount,
      country: session.country ?? null,
      jurisdictionId: session.jurisdictionId ?? null,
      jurisdictionName: session.jurisdictionName ?? null,
      jurisdictionKind: session.jurisdictionKind ?? null,
    };
  },
});

export const listMessages = query({
  args: {
    externalId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(chatMessageValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const userId = await optionalUserId(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };

    const session = await ctx.db
      .query("chatSessions")
      .withIndex("by_user_externalId", (q) =>
        q.eq("userId", userId).eq("externalId", args.externalId),
      )
      .unique();
    if (!session) return { page: [], isDone: true, continueCursor: "" };
    if ((session.jurisdictionId || await readUnifiedJurisdictionsEnabled(ctx)) &&
      !(await canAccessSession(ctx, session))) {
      return { page: [], isDone: true, continueCursor: "" };
    }

    const result = await ctx.db
      .query("messages")
      .withIndex("by_session_and_createdAt", (q) => q.eq("sessionId", session._id))
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: normalizePageSize(args.paginationOpts.numItems, MAX_MESSAGE_PAGE_SIZE),
      });

    return {
      // The database query reads newest-first so the cursor continues into
      // older history; each page itself remains chronological for consumers.
      page: result.page.reverse().map((message) => ({
        storageId: message._id,
        clientId: message.clientId ?? null,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        creationTime: message._creationTime,
        citations: message.citations,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const ensure = mutation({
  args: {
    externalId: v.string(),
    country: v.optional(v.string()),
    jurisdictionId: v.optional(v.string()),
    jurisdictionName: v.optional(v.string()),
    jurisdictionKind: v.optional(jurisdictionKindValidator),
  },
  returns: v.object({ id: v.string() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const unified = await readUnifiedJurisdictionsEnabled(ctx);
    const jurisdictionId = args.jurisdictionId === undefined
      ? undefined
      : ctx.db.normalizeId("jurisdictions", args.jurisdictionId);
    if (args.jurisdictionId !== undefined && !jurisdictionId) unavailable();
    const selectionArgs = { ...args, jurisdictionId: jurisdictionId ?? undefined };

    const existing = await ctx.db
      .query("chatSessions")
      .withIndex("by_user_externalId", (q) =>
        q.eq("userId", userId).eq("externalId", args.externalId)
      )
      .unique();

    if (existing) {
      const governed = unified || existing.jurisdictionId !== undefined;
      if (governed && !(await canAccessSession(ctx, existing))) unavailable();
      if (governed) assertSelectionMatches(existing, selectionArgs);
      return { id: existing.externalId };
    }

    if (!unified && args.jurisdictionId !== undefined) unavailable();

    let stableSnapshot: Pick<Doc<"chatSessions">, "jurisdictionId" | "jurisdictionName" | "jurisdictionKind" | "country"> = {};
    if (unified) {
      if (!jurisdictionId) unavailable();
      const row = await ctx.db.get("jurisdictions", jurisdictionId);
      if (!row) unavailable();
      const kind = await assertTypedJurisdiction(ctx, row);
      try { await assertJurisdictionAccess(ctx, row); } catch { unavailable(); }
      const country = isLegacyCountryCode(row.legacyCountryCode) ? row.legacyCountryCode : undefined;
      if (args.jurisdictionName !== undefined && args.jurisdictionName !== row.name) unavailable();
      if (args.jurisdictionKind !== undefined && args.jurisdictionKind !== kind) unavailable();
      if (args.country !== undefined && args.country.trim().toUpperCase() !== country) unavailable();
      stableSnapshot = { jurisdictionId: row._id, jurisdictionName: row.name, jurisdictionKind: kind, ...(country ? { country } : {}) };
    }

    await ctx.db.insert("chatSessions", {
      userId,
      externalId: args.externalId,
      title: "New chat",
      lastMessage: "",
      messageCount: 0,
      updatedAt: Date.now(),
      ...(unified ? stableSnapshot : { country: args.country }),
    });

    return { id: args.externalId };
  },
});

export const appendMessages = mutation({
  args: {
    externalId: v.string(),
    title: v.optional(v.string()),
    lastMessage: v.string(),
    country: v.optional(v.string()),
    jurisdictionId: v.optional(v.string()),
    jurisdictionName: v.optional(v.string()),
    jurisdictionKind: v.optional(jurisdictionKindValidator),
    messages: v.array(messageValidator),
  },
  returns: v.object({ id: v.string() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const unified = await readUnifiedJurisdictionsEnabled(ctx);
    const jurisdictionId = args.jurisdictionId === undefined
      ? undefined
      : ctx.db.normalizeId("jurisdictions", args.jurisdictionId);
    if (args.jurisdictionId !== undefined && !jurisdictionId) unavailable();
    const selectionArgs = { ...args, jurisdictionId: jurisdictionId ?? undefined };

    const session = await ctx.db
      .query("chatSessions")
      .withIndex("by_user_externalId", (q) =>
        q.eq("userId", userId).eq("externalId", args.externalId)
      )
      .unique();

    if (!session) {
      if (unified || args.jurisdictionId !== undefined) unavailable();
      throw new ConvexError("Chat session not found.");
    }
    if (unified || session.jurisdictionId !== undefined) {
      if (!(await canAccessSession(ctx, session))) unavailable();
      assertSelectionMatches(session, selectionArgs);
    }
    // Resolve every retry before any write or one-use claim consumption.
    const unsavedMessages: typeof args.messages = [];
    const pendingByClientId = new Map<string, (typeof args.messages)[number]>();
    for (const message of args.messages) {
      if (message.clientId) {
        const pending = pendingByClientId.get(message.clientId);
        if (pending) {
          if (!samePendingMessage(pending, message)) {
            throw new ConvexError("CHAT_CLIENT_ID_CONFLICT");
          }
          continue;
        }
        const existing = await ctx.db
          .query("messages")
          .withIndex("by_session_clientId", (q) =>
            q.eq("sessionId", session._id).eq("clientId", message.clientId)
          )
          .unique();
        if (existing) {
          if (existing.role !== message.role || existing.content !== message.content ||
            (message.createdAt !== undefined && !Object.is(existing.createdAt, message.createdAt)) ||
            !sameCitationSnapshots(existing.citations, message.role === "assistant" ? message.citations : undefined)) {
            throw new ConvexError("CHAT_CLIENT_ID_CONFLICT");
          }
          continue;
        }
        pendingByClientId.set(message.clientId, message);
      }
      unsavedMessages.push(message);
    }

    if (unsavedMessages.length === 0) return { id: session.externalId };
    if (session.jurisdictionId !== undefined && !unified) unavailable();

    for (const message of unsavedMessages) {
      await validateCitations(ctx, session, [message]);
      if (message.role === "assistant" && message.citations !== undefined) {
        await consumeCitationClaim(ctx, session, {
          clientId: message.clientId,
          content: message.content,
          citations: message.citations,
          citationClaim: message.citationClaim,
        });
      } else if (message.role === "assistant" && message.citationClaim !== undefined) {
        invalidCitationClaim();
      }

      await ctx.db.insert("messages", {
        sessionId: session._id,
        role: message.role,
        content: message.content,
        clientId: message.clientId,
        citations: message.role === "assistant" ? message.citations : undefined,
        createdAt: message.createdAt ?? Date.now(),
      });
    }

    await ctx.db.patch(session._id, {
      title: args.title ?? session.title,
      lastMessage: args.lastMessage,
      messageCount: session.messageCount + unsavedMessages.length,
      updatedAt: Date.now(),
    });

    return { id: session.externalId };
  },
});

export const remove = mutation({
  args: {
    externalId: v.string(),
  },
  returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const unified = await readUnifiedJurisdictionsEnabled(ctx);

    const session = await ctx.db
      .query("chatSessions")
      .withIndex("by_user_externalId", (q) =>
        q.eq("userId", userId).eq("externalId", args.externalId)
      )
      .unique();

    if (!session) {
      if (unified) unavailable();
      return { deleted: false };
    }
    if ((unified || session.jurisdictionId !== undefined) && !(await canAccessSession(ctx, session))) unavailable();

    await ctx.db.delete(session._id);
    await ctx.scheduler.runAfter(0, internal.chats.deleteMessageBatch, {
      sessionId: session._id,
    });
    return { deleted: true };
  },
});

export const deleteMessageBatch = internalMutation({
  args: { sessionId: v.id("chatSessions") },
  returns: v.object({ deletedCount: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .take(DELETE_BATCH_SIZE);
    for (const message of messages) await ctx.db.delete(message._id);

    const hasMore = messages.length === DELETE_BATCH_SIZE;
    if (hasMore) {
      await ctx.scheduler.runAfter(0, internal.chats.deleteMessageBatch, {
        sessionId: args.sessionId,
      });
    }
    return { deletedCount: messages.length, hasMore };
  },
});

export const migrateFromLocal = mutation({
  args: {
    sessions: v.array(
      v.object({
        externalId: v.string(),
        title: v.string(),
        lastMessage: v.string(),
        messageCount: v.number(),
        updatedAt: v.number(),
        messages: v.array(legacyLocalMessageValidator),
      })
    ),
  },
  returns: v.object({ migratedCount: v.number() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    let migratedCount = 0;

    for (const localSession of args.sessions) {
      const existing = await ctx.db
        .query("chatSessions")
        .withIndex("by_user_externalId", (q) =>
          q.eq("userId", userId).eq("externalId", localSession.externalId)
        )
        .unique();

      if (existing) continue;

      const sessionId = await ctx.db.insert("chatSessions", {
        userId,
        externalId: localSession.externalId,
        title: localSession.title,
        lastMessage: localSession.lastMessage,
        messageCount: localSession.messageCount,
        updatedAt: localSession.updatedAt,
      });

      for (const message of localSession.messages) {
        await ctx.db.insert("messages", {
          sessionId: sessionId as Id<"chatSessions">,
          role: message.role,
          content: message.content,
          clientId: message.clientId,
          createdAt: message.createdAt ?? localSession.updatedAt,
        });
      }

      migratedCount += 1;
    }

    return { migratedCount };
  },
});
