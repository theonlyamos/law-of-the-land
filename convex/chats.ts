import { makeFunctionReference, paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { components, internal } from "./_generated/api";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { optionalUserId, requireUserId } from "./lib/requireUser";
import {
  chatCitationValidator,
  allowedParentLevelsByLevel,
  jurisdictionKindValidator,
  MAX_GEOGRAPHIC_DEPTH,
  type ChatCitation,
  type JurisdictionKind,
} from "./lib/jurisdictionDomain";
import {
  activeOrganizationIdsForUser,
  assertJurisdictionAccess,
} from "./lib/jurisdictionAccess";
import {
  createCitationClaimBindings,
  type ClaimCitation,
} from "./lib/chatCitationClaim";
import {
  createOpaqueTelemetryToken,
  createTelemetryPrincipalBinding,
  hashOpaqueTelemetryValue,
  isOpaqueTelemetryToken,
  verifyTelemetryServiceProof,
} from "./lib/telemetryProof";
import {
  isGeminiDocumentName,
  isGeminiFileSearchStoreName,
} from "./lib/geminiFileSearchNames";
import { resolveChatResearchStoresForJurisdiction } from "./jurisdictions";

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


const MAX_SESSION_PAGE_SIZE = 30;
const MAX_MESSAGE_PAGE_SIZE = 50;
const DELETE_BATCH_SIZE = 100;
const MAX_CITATIONS = 16;
const MAX_CITATION_LABEL_LENGTH = 200;
const MAX_ORGANIZATION_SCOPE_LINKS = 8;
const CITATION_CLAIM_TTL_MS = 2 * 60_000;
const MAX_CHAT_EXTERNAL_ID_LENGTH = 200;
const MAX_ASSISTANT_CLIENT_ID_LENGTH = 200;
const MAX_ASSISTANT_CONTENT_BYTES = 64 * 1024;
const MAX_MODEL_NAME_LENGTH = 100;
const MAX_ROUTE_SCOPE_SIZE = 4;
const MAX_PROVIDER_LATENCY_MS = 10 * 60_000;
const MAX_PAGE_NUMBER = 10_000;
const expireCitationClaimRef = makeFunctionReference<"mutation">("chats:expireCitationClaim");
type ChatCtx = QueryCtx | MutationCtx;

type GovernedInteractionOutcome = "success" | "failure" | "aborted";
type GovernedFailureCategory =
  | "authentication"
  | "configuration"
  | "network"
  | "timeout"
  | "validation"
  | "internal";
type GovernedCitationIdentity = {
  jurisdictionId: string;
  resourceId: string;
  versionId: string;
  providerStoreName: string;
  pageNumber?: number;
};
type GovernedJurisdictionCoverage = {
  ordinal: number;
  relation: "selected" | "geographic_ancestor" | "organizational_geography";
  coverage: "evidence" | "no_evidence" | "unavailable";
};
type GovernedCompletionProofInput = {
  routeNonce: string;
  externalId: string;
  jurisdictionId: string;
  assistantClientId: string;
  finalAnswer?: string;
  citations: readonly GovernedCitationIdentity[];
  model: string;
  elapsedMs: number;
  outcome: GovernedInteractionOutcome;
  failureCategory?: GovernedFailureCategory;
  authorizedScopeSize: number;
  readyStoreCount: number;
  partialCoverage: boolean;
  jurisdictionCoverage: readonly GovernedJurisdictionCoverage[];
};

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

const governedInteractionOutcomeValidator = v.union(
  v.literal("success"),
  v.literal("failure"),
  v.literal("aborted"),
);
const governedFailureCategoryValidator = v.union(
  v.literal("authentication"),
  v.literal("configuration"),
  v.literal("network"),
  v.literal("timeout"),
  v.literal("validation"),
  v.literal("internal"),
);
const governedCitationIdentityValidator = v.object({
  jurisdictionId: v.string(),
  resourceId: v.string(),
  versionId: v.string(),
  providerStoreName: v.string(),
  pageNumber: v.optional(v.number()),
});
const governedJurisdictionCoverageValidator = v.object({
  ordinal: v.number(),
  relation: v.union(
    v.literal("selected"),
    v.literal("geographic_ancestor"),
    v.literal("organizational_geography"),
  ),
  coverage: v.union(
    v.literal("evidence"),
    v.literal("no_evidence"),
    v.literal("unavailable"),
  ),
});
function boundedIdentifier(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && value === value.trim();
}

function validCount(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

export async function completeGovernedInteractionProofParts(
  input: GovernedCompletionProofInput,
): Promise<readonly (string | number)[]> {
  const bindings = await createCitationClaimBindings(
    input.assistantClientId,
    input.finalAnswer ?? "",
    [],
  );
  return [
    "complete-governed-interaction-v2",
    input.routeNonce,
    input.externalId,
    input.jurisdictionId,
    bindings.assistantClientIdBinding,
    bindings.assistantContentBinding,
    input.model,
    input.elapsedMs,
    input.outcome,
    input.failureCategory ?? "",
    input.authorizedScopeSize,
    input.readyStoreCount,
    input.partialCoverage ? 1 : 0,
    input.jurisdictionCoverage.length,
    ...input.jurisdictionCoverage.flatMap((item) => [
      item.ordinal,
      item.relation,
      item.coverage,
    ]),
    input.citations.length,
    ...input.citations.flatMap((citation) => [
      citation.jurisdictionId,
      citation.resourceId,
      citation.versionId,
      citation.providerStoreName,
      citation.pageNumber ?? 0,
    ]),
  ];
}

async function governedCompletionBindings(input: GovernedCompletionProofInput) {
  const claimBindings = await createCitationClaimBindings(
    input.assistantClientId,
    input.finalAnswer ?? "",
    [],
  );
  const completionBinding = await hashOpaqueTelemetryValue(JSON.stringify([
    "governed-completion-idempotency-v2",
    input.externalId,
    input.jurisdictionId,
    claimBindings.assistantContentBinding,
    input.outcome,
    input.failureCategory ?? "",
    input.partialCoverage,
    input.citations.map((citation) => [
      citation.jurisdictionId,
      citation.resourceId,
      citation.versionId,
      citation.providerStoreName,
      citation.pageNumber ?? 0,
    ]),
  ]));
  return {
    assistantClientIdBinding: claimBindings.assistantClientIdBinding,
    completionBinding,
  };
}

function validateGovernedCompletionInput(input: GovernedCompletionProofInput): void {
  const answer = input.finalAnswer;
  if (
    !isOpaqueTelemetryToken(input.routeNonce)
    || !boundedIdentifier(input.externalId, MAX_CHAT_EXTERNAL_ID_LENGTH)
    || !boundedIdentifier(input.jurisdictionId, MAX_CHAT_EXTERNAL_ID_LENGTH)
    || !boundedIdentifier(input.assistantClientId, MAX_ASSISTANT_CLIENT_ID_LENGTH)
    || !boundedIdentifier(input.model, MAX_MODEL_NAME_LENGTH)
    || !Number.isSafeInteger(input.elapsedMs)
    || input.elapsedMs < 0
    || input.elapsedMs > MAX_PROVIDER_LATENCY_MS
    || !validCount(input.authorizedScopeSize, MAX_ROUTE_SCOPE_SIZE)
    || input.authorizedScopeSize === 0
    || !validCount(input.readyStoreCount, input.authorizedScopeSize)
    || input.readyStoreCount === 0
    || input.jurisdictionCoverage.length !== input.readyStoreCount
    || input.jurisdictionCoverage.some((item, index) =>
      item.ordinal !== index
      || (index === 0 && item.relation !== "selected")
      || (index > 0 && item.relation === "selected"))
    || input.citations.length > MAX_CITATIONS
    || input.citations.some((citation) =>
      !boundedIdentifier(citation.jurisdictionId, MAX_CHAT_EXTERNAL_ID_LENGTH)
      || !boundedIdentifier(citation.resourceId, MAX_CHAT_EXTERNAL_ID_LENGTH)
      || !boundedIdentifier(citation.versionId, MAX_CHAT_EXTERNAL_ID_LENGTH)
      || !isGeminiFileSearchStoreName(citation.providerStoreName)
      || (citation.pageNumber !== undefined
        && (!Number.isSafeInteger(citation.pageNumber)
          || citation.pageNumber <= 0
          || citation.pageNumber > MAX_PAGE_NUMBER)))
  ) {
    throw new ConvexError("INVALID_GOVERNED_INTERACTION");
  }
  if (input.outcome === "success") {
    if (
      answer === undefined
      || !answer.trim()
      || new TextEncoder().encode(answer).byteLength > MAX_ASSISTANT_CONTENT_BYTES
      || input.citations.length === 0
      || input.failureCategory !== undefined
      || input.jurisdictionCoverage[0]?.coverage !== "evidence"
    ) throw new ConvexError("INVALID_GOVERNED_INTERACTION");
    return;
  }
  if (answer !== undefined || input.citations.length !== 0) {
    throw new ConvexError("INVALID_GOVERNED_INTERACTION");
  }
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
  if (!session.jurisdictionId || !session.jurisdictionName?.trim() ||
    !session.jurisdictionKind || session.jurisdictionContract !== "unified") return false;
  if (cache) {
    const cacheKey = `${session.jurisdictionId}:${session.jurisdictionName}:${session.jurisdictionKind}`;
    const cached = cache.get(cacheKey);
    if (cached) return await cached;
    const pending = canAccessSession(ctx, session, activeOrganizationIds);
    cache.set(cacheKey, pending);
    return await pending;
  }
  const row = await ctx.db.get("jurisdictions", session.jurisdictionId);
  if (!row) return false;
  try {
    const kind = await assertTypedJurisdiction(ctx, row);
    if (session.jurisdictionKind !== kind) return false;
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
}) {
  if (args.jurisdictionId !== undefined && args.jurisdictionId !== session.jurisdictionId) unavailable();
  if (args.jurisdictionName !== undefined && args.jurisdictionName !== session.jurisdictionName) unavailable();
  if (args.jurisdictionKind !== undefined && args.jurisdictionKind !== session.jurisdictionKind) unavailable();
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

type GovernedCompletionAuthority = {
  publicCitations: ChatCitation[];
  authorizedScopeSize: number;
  readyStoreCount: number;
  partialCoverage: boolean;
  jurisdictionCoverage: GovernedJurisdictionCoverage[];
};

async function resolveGovernedCompletionAuthority(
  ctx: MutationCtx,
  session: Doc<"chatSessions">,
  jurisdictionId: Id<"jurisdictions">,
  citations: readonly GovernedCitationIdentity[],
): Promise<GovernedCompletionAuthority> {
  const resolution = await resolveChatResearchStoresForJurisdiction(ctx, jurisdictionId);
  const stores = new Map(resolution.stores.map((store) => [store.jurisdictionId, store]));
  const seen = new Set<string>();
  const publicCitations: ChatCitation[] = [];
  for (const citation of citations) {
    const citedJurisdictionId = ctx.db.normalizeId("jurisdictions", citation.jurisdictionId);
    const resourceId = ctx.db.normalizeId("legalResources", citation.resourceId);
    const versionId = ctx.db.normalizeId("documentVersions", citation.versionId);
    const store = citedJurisdictionId ? stores.get(citedJurisdictionId) : undefined;
    const key = `${citation.jurisdictionId}\u0000${citation.resourceId}\u0000${citation.versionId}\u0000${citation.providerStoreName}\u0000${citation.pageNumber ?? ""}`;
    if (!citedJurisdictionId || !resourceId || !versionId || !store || seen.has(key)) {
      throw new ConvexError("INVALID_CHAT_CITATIONS");
    }
    seen.add(key);
    const [resource, version, locks] = await Promise.all([
      ctx.db.get("legalResources", resourceId),
      ctx.db.get("documentVersions", versionId),
      ctx.db
        .query("documentLifecycleLocks")
        .withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId))
        .take(1),
    ]);
    const documentName = version?.geminiDocumentName;
    const title = resource?.title.trim();
    const label = title
      ? `${title}${citation.pageNumber === undefined ? "" : `, page ${citation.pageNumber}`}`
      : "";
    if (
      !resource
      || resource.jurisdictionId !== citedJurisdictionId
      || resource.status !== "active"
      || resource.activeVersionId !== versionId
      || !version
      || version.resourceId !== resourceId
      || version.status !== "published"
      || !documentName
      || !isGeminiDocumentName(documentName)
      || citation.providerStoreName !== store.storeName
      || !documentName.startsWith(`${store.storeName}/documents/`)
      || locks.length !== 0
      || !label
      || label.length > MAX_CITATION_LABEL_LENGTH
    ) throw new ConvexError("INVALID_CHAT_CITATIONS");
    publicCitations.push({
      label,
      jurisdictionId: citedJurisdictionId,
      jurisdictionName: store.name,
      jurisdictionKind: store.kind,
      relation: store.relation,
    });
  }
  if (citations.length > 0) {
    if (!publicCitations.some((citation) => citation.jurisdictionId === jurisdictionId)) {
      throw new ConvexError("INVALID_CHAT_CITATIONS");
    }
    await validateCitations(ctx, session, [{ role: "assistant", citations: publicCitations }]);
  }
  const citedJurisdictionIds = new Set(
    publicCitations.map((citation) => citation.jurisdictionId),
  );
  return {
    publicCitations,
    authorizedScopeSize: resolution.authorizedScopeSize,
    readyStoreCount: resolution.stores.length,
    partialCoverage: resolution.partialCoverage,
    jurisdictionCoverage: resolution.stores.map((store, ordinal) => ({
      ordinal,
      relation: store.relation,
      coverage: citedJurisdictionIds.has(store.jurisdictionId)
        ? "evidence" as const
        : "no_evidence" as const,
    })),
  };
}

function matchesCurrentScope(
  input: GovernedCompletionProofInput,
  authority: GovernedCompletionAuthority,
): boolean {
  return input.authorizedScopeSize === authority.authorizedScopeSize
    && input.readyStoreCount === authority.readyStoreCount
    && input.partialCoverage === authority.partialCoverage
    && input.jurisdictionCoverage.length === authority.jurisdictionCoverage.length
    && input.jurisdictionCoverage.every((item, index) => {
      const current = authority.jurisdictionCoverage[index];
      return current !== undefined
        && item.ordinal === current.ordinal
        && item.relation === current.relation
        && item.coverage === current.coverage;
    });
}

const completionResultValidator = v.union(
  v.object({
    status: v.literal("completed"),
    outcome: v.literal("success"),
    citations: v.array(chatCitationValidator),
    partialCoverage: v.boolean(),
    citationClaim: v.string(),
    expiresAt: v.number(),
  }),
  v.object({
    status: v.literal("completed"),
    outcome: v.union(v.literal("failure"), v.literal("aborted")),
  }),
  v.object({
    status: v.literal("replayed"),
    outcome: governedInteractionOutcomeValidator,
  }),
);

export const completeGovernedInteraction = mutation({
  args: {
    routeNonce: v.string(),
    externalId: v.string(),
    jurisdictionId: v.string(),
    assistantClientId: v.string(),
    finalAnswer: v.optional(v.string()),
    citations: v.array(governedCitationIdentityValidator),
    model: v.string(),
    elapsedMs: v.number(),
    outcome: governedInteractionOutcomeValidator,
    failureCategory: v.optional(governedFailureCategoryValidator),
    authorizedScopeSize: v.number(),
    readyStoreCount: v.number(),
    partialCoverage: v.boolean(),
    jurisdictionCoverage: v.array(governedJurisdictionCoverageValidator),
    serviceProof: v.string(),
  },
  returns: completionResultValidator,
  handler: async (ctx, args) => {
    const input: GovernedCompletionProofInput = args;
    validateGovernedCompletionInput(input);
    if (!(await verifyTelemetryServiceProof(
      args.serviceProof,
      await completeGovernedInteractionProofParts(input),
    ))) throw new ConvexError("GOVERNED_INTERACTION_SERVICE_PROOF_INVALID");

    const jurisdictionId = ctx.db.normalizeId("jurisdictions", args.jurisdictionId);
    if (!jurisdictionId) throw new ConvexError("INVALID_GOVERNED_INTERACTION");
    const userId = await requireUserId(ctx);
    const session = await ctx.db
      .query("chatSessions")
      .withIndex("by_user_externalId", (q) =>
        q.eq("userId", userId).eq("externalId", args.externalId))
      .unique();
    if (
      !session
      || session.jurisdictionId !== jurisdictionId
      || !(await canAccessSession(ctx, session))
    ) throw new ConvexError("INVALID_GOVERNED_INTERACTION");
    const selected = await ctx.db.get("jurisdictions", jurisdictionId);
    if (!selected) throw new ConvexError("INVALID_GOVERNED_INTERACTION");
    let kind: JurisdictionKind;
    try {
      kind = await assertTypedJurisdiction(ctx, selected);
    } catch {
      throw new ConvexError("INVALID_GOVERNED_INTERACTION");
    }

    const requestNonceHash = await hashOpaqueTelemetryValue(args.routeNonce);
    const nonceRows = await ctx.db
      .query("queryRuns")
      .withIndex("by_requestNonceHash", (q) => q.eq("requestNonceHash", requestNonceHash))
      .take(2);
    if (nonceRows.length > 1) throw new ConvexError("GOVERNED_INTERACTION_REPLAY_INVALID");
    if (nonceRows.length === 1) {
      if (nonceRows[0].chatSessionId !== session._id) {
        throw new ConvexError("GOVERNED_INTERACTION_REPLAY_INVALID");
      }
      return { status: "replayed" as const, outcome: nonceRows[0].outcome };
    }

    const idempotency = await governedCompletionBindings(input);
    const clientRows = await ctx.db
      .query("queryRuns")
      .withIndex("by_chatSessionId_and_assistantClientIdBinding", (q) =>
        q
          .eq("chatSessionId", session._id)
          .eq("assistantClientIdBinding", idempotency.assistantClientIdBinding))
      .take(2);
    if (clientRows.length > 1) throw new ConvexError("CHAT_CLIENT_ID_CONFLICT");
    if (clientRows.length === 1) {
      if (!opaqueEqual(clientRows[0].completionBinding, idempotency.completionBinding)) {
        throw new ConvexError("CHAT_CLIENT_ID_CONFLICT");
      }
      return { status: "replayed" as const, outcome: clientRows[0].outcome };
    }

    let authority: GovernedCompletionAuthority | null = null;
    if (args.outcome === "success") {
      authority = await resolveGovernedCompletionAuthority(
        ctx,
        session,
        jurisdictionId,
        args.citations,
      );
      if (!matchesCurrentScope(input, authority)) {
        throw new ConvexError("INVALID_GOVERNED_INTERACTION");
      }
    }
    const publicCitations = authority?.publicCitations ?? [];
    const terminalScope = authority ?? {
      authorizedScopeSize: args.authorizedScopeSize,
      readyStoreCount: args.readyStoreCount,
      partialCoverage: args.partialCoverage,
      jurisdictionCoverage: args.jurisdictionCoverage,
    };
    const now = Date.now();
    let claim: { citationClaim: string; expiresAt: number } | null = null;
    if (publicCitations.length > 0) {
      const principal = await citationClaimPrincipal(ctx);
      const citationClaim = createOpaqueTelemetryToken();
      const tokenHash = await hashOpaqueTelemetryValue(citationClaim);
      const duplicates = await ctx.db
        .query("chatCitationClaims")
        .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
        .take(2);
      if (duplicates.length !== 0) invalidCitationClaim();
      const claimBindings = await createCitationClaimBindings(
        args.assistantClientId,
        args.finalAnswer!,
        publicCitations,
      );
      const expiresAt = now + CITATION_CLAIM_TTL_MS;
      await ctx.db.insert("chatCitationClaims", {
        tokenHash,
        ...principal,
        chatSessionId: session._id,
        jurisdictionId,
        ...claimBindings,
        expiresAt,
      });
      await ctx.scheduler.runAt(expiresAt, expireCitationClaimRef, { tokenHash });
      claim = { citationClaim, expiresAt };
    }
    await ctx.db.insert("queryRuns", {
      requestNonceHash,
      chatSessionId: session._id,
      ...idempotency,
      day: new Date(now).toISOString().slice(0, 10),
      jurisdictionId,
      jurisdictionName: selected.name,
      jurisdictionKind: kind,
      outcome: args.outcome,
      ...(args.failureCategory ? { failureCategory: args.failureCategory } : {}),
      model: args.model,
      totalLatencyMs: args.elapsedMs,
      authorizedScopeSize: terminalScope.authorizedScopeSize,
      readyStoreCount: terminalScope.readyStoreCount,
      citationCount: publicCitations.length,
      partialCoverage: terminalScope.partialCoverage,
      jurisdictionCoverage: terminalScope.jurisdictionCoverage,
      completedAt: now,
      rollupStatus: "pending",
    });
    if (args.outcome !== "success") {
      return { status: "completed" as const, outcome: args.outcome };
    }
    if (!claim) throw new ConvexError("INVALID_CHAT_CITATIONS");
    return {
      status: "completed" as const,
      outcome: "success" as const,
      citations: publicCitations,
      partialCoverage: terminalScope.partialCoverage,
      ...claim,
    };
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

    let memberships: Set<Id<"organizations">> | null = null;
    try { memberships = await activeOrganizationIdsForUser(ctx, userId); } catch { memberships = null; }
    const cache = new Map<string, Promise<boolean>>();
    const access = await Promise.all(result.page.map((session) =>
      canAccessSession(ctx, session, memberships, cache)));
    const visible = result.page.filter((_, index) => access[index]);
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
    if (!(await canAccessSession(ctx, session))) return null;

    return {
      id: session.externalId,
      title: session.title,
      lastMessage: session.lastMessage,
      timestamp: session.updatedAt,
      messageCount: session.messageCount,
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
    if (!(await canAccessSession(ctx, session))) {
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
    jurisdictionId: v.optional(v.string()),
    jurisdictionName: v.optional(v.string()),
    jurisdictionKind: v.optional(jurisdictionKindValidator),
  },
  returns: v.object({ id: v.string() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
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
      if (!(await canAccessSession(ctx, existing))) unavailable();
      assertSelectionMatches(existing, selectionArgs);
      return { id: existing.externalId };
    }

    if (!jurisdictionId) unavailable();
    const row = await ctx.db.get("jurisdictions", jurisdictionId);
    if (!row) unavailable();
    const kind = await assertTypedJurisdiction(ctx, row);
    try { await assertJurisdictionAccess(ctx, row); } catch { unavailable(); }
    if (args.jurisdictionName !== undefined && args.jurisdictionName !== row.name) unavailable();
    if (args.jurisdictionKind !== undefined && args.jurisdictionKind !== kind) unavailable();

    await ctx.db.insert("chatSessions", {
      userId,
      externalId: args.externalId,
      title: "New chat",
      lastMessage: "",
      messageCount: 0,
      updatedAt: Date.now(),
      jurisdictionId: row._id,
      jurisdictionName: row.name,
      jurisdictionKind: kind,
      jurisdictionContract: "unified",
    });

    return { id: args.externalId };
  },
});

export const appendMessages = mutation({
  args: {
    externalId: v.string(),
    title: v.optional(v.string()),
    lastMessage: v.string(),
    jurisdictionId: v.optional(v.string()),
    jurisdictionName: v.optional(v.string()),
    jurisdictionKind: v.optional(jurisdictionKindValidator),
    messages: v.array(messageValidator),
  },
  returns: v.object({ id: v.string() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
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

    if (!session || !(await canAccessSession(ctx, session))) unavailable();
    assertSelectionMatches(session, selectionArgs);
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

    const session = await ctx.db
      .query("chatSessions")
      .withIndex("by_user_externalId", (q) =>
        q.eq("userId", userId).eq("externalId", args.externalId)
      )
      .unique();

    if (!session) return { deleted: false };
    if (!(await canAccessSession(ctx, session))) unavailable();

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
