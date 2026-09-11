import { ConvexError, v } from "convex/values";
import { internalQuery, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import {
  jurisdictionKindValidator,
  jurisdictionSearchPageValidator,
  MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS,
  MAX_SELECTOR_PAGE_SIZE,
  type JurisdictionKind,
  type ResearchScopeItem,
} from "./lib/jurisdictionDomain";
import { isGeminiFileSearchStoreName } from "./lib/geminiFileSearchNames";
import {
  activeOrganizationIdsForUser,
  assertJurisdictionAccess,
  getAccessibleJurisdictionById,
} from "./lib/jurisdictionAccess";
import { optionalUserId } from "./lib/requireUser";
import { resolveResearchScopeForJurisdiction } from "./lib/researchScope";

const accessibleJurisdictionValidator = v.object({
  _id: v.id("jurisdictions"),
  name: v.string(),
  slug: v.string(),
  status: v.literal("enabled"),
  kind: v.union(v.literal("geographic"), v.literal("organizational")),
  visibility: v.union(v.literal("public"), v.literal("members")),
});

const MAX_SEARCH_QUERY_LENGTH = 120;
const MAX_RESEARCH_JURISDICTION_ID_LENGTH = 200;
const MAX_CURSOR_LENGTH = 4096;
const MAX_NESTED_CURSOR_LENGTH = 2048;

type SearchPhase = "members" | "public";
type SearchCursor = {
  v: 2;
  kind: JurisdictionKind;
  q: string;
  phase: SearchPhase;
  memberOffset?: number;
  memberCursor?: string | null;
  publicCursor?: string | null;
};

type ResearchJurisdiction = {
  id: Id<"jurisdictions">;
  name: string;
  slug: string;
  kind: JurisdictionKind;
  isDefault: boolean;
  organization?: { id: Id<"organizations">; name: string };
  visibility?: "public" | "members";
};

function invalidCursor(): never {
  throw new ConvexError("INVALID_JURISDICTION_SEARCH_CURSOR");
}

function normalizeSearchQuery(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (normalized.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new ConvexError("INVALID_JURISDICTION_SEARCH_QUERY");
  }
  return normalized;
}

async function queryFingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  if (!value || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    invalidCursor();
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  try {
    const binary = atob(padded);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    invalidCursor();
  }
}

function encodeCursor(cursor: SearchCursor): string {
  const encoded = encodeBase64Url(JSON.stringify(cursor));
  if (encoded.length > MAX_CURSOR_LENGTH) invalidCursor();
  return encoded;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function decodeCursor(
  value: string,
  kind: JurisdictionKind,
  fingerprint: string,
): SearchCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(value));
  } catch (error) {
    if (error instanceof ConvexError) throw error;
    invalidCursor();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalidCursor();
  const candidate = parsed as Record<string, unknown>;
  const allowed = new Set(["v", "kind", "q", "phase", "memberOffset", "memberCursor", "publicCursor"]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) invalidCursor();
  if (
    candidate.v !== 2 ||
    candidate.kind !== kind ||
    candidate.q !== fingerprint ||
    (candidate.phase !== "members" && candidate.phase !== "public")
  ) {
    invalidCursor();
  }
  if (candidate.phase === "members") {
    if (
      kind !== "organizational" ||
      hasOwn(candidate, "publicCursor") ||
      !Number.isInteger(candidate.memberOffset) ||
      (candidate.memberOffset as number) < 0 ||
      (candidate.memberOffset as number) > MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS
    ) {
      invalidCursor();
    }
  } else {
    if (hasOwn(candidate, "memberOffset")) invalidCursor();
    if (
      candidate.publicCursor !== null &&
      (typeof candidate.publicCursor !== "string" ||
        candidate.publicCursor.length > MAX_NESTED_CURSOR_LENGTH ||
        !/^[A-Za-z0-9_-]+$/u.test(candidate.publicCursor))
    ) {
      invalidCursor();
    }
  }
  if (candidate.memberCursor != null && (typeof candidate.memberCursor !== "string" || candidate.memberCursor.length > MAX_NESTED_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(candidate.memberCursor))) invalidCursor();
  return candidate as SearchCursor;
}

async function projectResearchJurisdiction(ctx: QueryCtx, row: Doc<"jurisdictions">): Promise<ResearchJurisdiction> {
  const organization = row.organizationId ? await ctx.db.get(row.organizationId) : null;
  return {
    id: row._id,
    name: row.name,
    slug: row.slug,
    kind: row.kind as JurisdictionKind,
    isDefault: row.isDefault,
    ...(organization ? { organization: { id: organization._id, name: organization.name }, visibility: row.visibility ?? "members" } : {}),
  };
}

async function assertTypedRelationship(
  ctx: QueryCtx,
  row: Doc<"jurisdictions">,
  kind: JurisdictionKind,
): Promise<void> {
  if (row.kind !== kind || row.status !== "enabled") {
    throw new ConvexError("JURISDICTION_SELECTOR_STATE_INVALID");
  }
  if (kind === "geographic") {
    const [geographicProfiles, organizationalProfiles] = await Promise.all([
      ctx.db
        .query("geographicJurisdictions")
        .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", row._id))
        .take(2),
      ctx.db
        .query("organizationalJurisdictions")
        .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", row._id))
        .take(1),
    ]);
    if (
      geographicProfiles.length !== 1 ||
      organizationalProfiles.length !== 0 ||
      row.organizationId !== undefined
    ) {
      throw new ConvexError("JURISDICTION_SELECTOR_STATE_INVALID");
    }
    return;
  }
  if (!row.organizationId) throw new ConvexError("JURISDICTION_SELECTOR_STATE_INVALID");
  const [organizationalProfiles, geographicProfiles, organization] = await Promise.all([
    ctx.db
      .query("organizationalJurisdictions")
      .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", row._id))
      .take(2),
    ctx.db
      .query("geographicJurisdictions")
      .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", row._id))
      .take(1),
    ctx.db.get("organizations", row.organizationId),
  ]);
  if (
    organizationalProfiles.length !== 1 ||
    geographicProfiles.length !== 0 ||
    !organization ||
    organization.status !== "active"
  ) {
    throw new ConvexError("JURISDICTION_SELECTOR_STATE_INVALID");
  }
}

async function publicSearchPage(
  ctx: QueryCtx,
  kind: JurisdictionKind,
  normalizedQuery: string,
  nestedCursor: string | null,
  fingerprint: string,
  memberIds: ReadonlySet<Id<"organizations">> = new Set(),
) {
  const paginationOptions = { numItems: MAX_SELECTOR_PAGE_SIZE, cursor: nestedCursor };
  const organizationSearch = kind === "organizational" && !!normalizedQuery;
  const result = organizationSearch ? await ctx.db.query("jurisdictions").withSearchIndex("search_discoveryText", q => q.search("discoveryText", normalizedQuery).eq("kind", "organizational").eq("status", "enabled").eq("visibility", "public")).paginate(paginationOptions) : normalizedQuery
    ? await ctx.db
        .query("jurisdictions")
        .withSearchIndex("search_name", (q) =>
          q
            .search("name", normalizedQuery)
            .eq("kind", kind)
            .eq("status", "enabled")
            .eq("visibility", "public"),
        )
        .paginate(paginationOptions)
    : await ctx.db
        .query("jurisdictions")
        .withIndex("by_kind_and_status_and_visibility_and_name", (q) =>
          q.eq("kind", kind).eq("status", "enabled").eq("visibility", "public"),
        )
        .paginate(paginationOptions);
  const visible = (await Promise.all(result.page.map(async row => {
    if (row.organizationId) {
      if (memberIds.has(row.organizationId)) return null;
      const organization = await ctx.db.get(row.organizationId);
      if (organization?.status !== "active") return null;
    }
    await assertTypedRelationship(ctx, row, kind);
    return row;
  }))).filter(row => row !== null);
  return {
    page: await Promise.all(visible.map(row => projectResearchJurisdiction(ctx, row))),
    group: kind === "geographic" ? ("geographic" as const) : ("public_organizations" as const),
    isDone: result.isDone,
    continueCursor: result.isDone
      ? null
      : encodeCursor({
          v: 2,
          kind,
          q: fingerprint,
          phase: "public",
          publicCursor: encodeBase64Url(result.continueCursor),
        }),
  };
}

const researchJurisdictionValidator = v.union(
  v.null(),
  v.object({
    id: v.id("jurisdictions"),
    name: v.string(),
    slug: v.string(),
    kind: jurisdictionKindValidator,
    isDefault: v.boolean(),
    organization: v.optional(v.object({ id: v.id("organizations"), name: v.string() })),
    visibility: v.optional(v.union(v.literal("public"), v.literal("members"))),
  }),
);

/** Returns the safe jurisdiction projection when the caller has server-derived access. */
export const getAccessibleById = query({
  args: { id: v.id("jurisdictions") },
  returns: v.union(accessibleJurisdictionValidator, v.null()),
  handler: async (ctx, args) => await getAccessibleJurisdictionById(ctx, args.id),
});

/** Resolves a stable browser selection without exposing provider configuration. */
export const resolveResearchSelection = query({
  args: { jurisdictionId: v.string() },
  returns: researchJurisdictionValidator,
  handler: async (ctx, args) => {
    if (
      args.jurisdictionId.length === 0
      || args.jurisdictionId.length > MAX_RESEARCH_JURISDICTION_ID_LENGTH
    ) {
      return null;
    }
    try {
      const jurisdictionId = ctx.db.normalizeId("jurisdictions", args.jurisdictionId);
      if (!jurisdictionId) return null;
      const selected = await ctx.db.get("jurisdictions", jurisdictionId);
      if (!selected) return null;
      await assertJurisdictionAccess(ctx, selected);
      const kind = selected.kind;
      if (kind !== "geographic" && kind !== "organizational") return null;
      await assertTypedRelationship(ctx, selected, kind);
      return projectResearchJurisdiction(ctx, selected);
    } catch {
      return null;
    }
  },
});

/** Browser-safe, bounded selector with member-first organizational pagination. */
export const searchAccessible = query({
  args: {
    kind: jurisdictionKindValidator,
    query: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: jurisdictionSearchPageValidator,
  handler: async (ctx, args) => {
    const normalizedQuery = normalizeSearchQuery(args.query);
    const userId = args.kind === "organizational" ? await optionalUserId(ctx) : null;
    const memberIds = userId ? await activeOrganizationIdsForUser(ctx, userId) : new Set<Id<"organizations">>();
    const sortedIds = [...memberIds].sort();
    const fingerprint = await queryFingerprint(JSON.stringify([normalizedQuery, userId, sortedIds]));
    const cursor = args.cursor
      ? decodeCursor(args.cursor, args.kind, fingerprint)
      : null;

    if (args.kind === "geographic") {
      if (cursor?.phase === "members") invalidCursor();
      return await publicSearchPage(
        ctx,
        args.kind,
        normalizedQuery,
        cursor?.publicCursor ? decodeBase64Url(cursor.publicCursor) : null,
        fingerprint,
      );
    }

    if (cursor?.phase === "members" && !userId) invalidCursor();
    if (userId && (!cursor || cursor.phase === "members")) {
      let offset = cursor?.memberOffset ?? 0;
      if (offset > sortedIds.length) invalidCursor();
      for (let probes = 0; offset < sortedIds.length && probes < 5; probes++, offset++) {
        const organizationId = sortedIds[offset], organization = await ctx.db.get(organizationId);
        if (organization?.status !== "active") continue;
        const paginationOpts = { numItems: MAX_SELECTOR_PAGE_SIZE, cursor: offset === cursor?.memberOffset && cursor.memberCursor ? decodeBase64Url(cursor.memberCursor) : null };
        const build = () => normalizedQuery
          ? ctx.db.query("jurisdictions").withSearchIndex("search_discoveryText", q => q.search("discoveryText", normalizedQuery).eq("organizationId", organizationId).eq("status", "enabled"))
          : ctx.db.query("jurisdictions").withIndex("by_organizationId_and_status_and_name", q => q.eq("organizationId", organizationId).eq("status", "enabled"));
        if (!(await build().take(1)).length) continue;
        const result = await build().paginate(paginationOpts);
        await Promise.all(result.page.map(row => assertTypedRelationship(ctx, row, "organizational")));
        return { page: await Promise.all(result.page.map(row => projectResearchJurisdiction(ctx, row))), group: "your_organizations" as const, isDone: false,
          continueCursor: encodeCursor({ v: 2, kind: args.kind, q: fingerprint, phase: "members", memberOffset: result.isDone ? offset + 1 : offset, memberCursor: result.isDone ? null : encodeBase64Url(result.continueCursor) }) };
      }
      if (offset < sortedIds.length) return { page: [], group: "your_organizations" as const, isDone: false, continueCursor: encodeCursor({ v: 2, kind: args.kind, q: fingerprint, phase: "members", memberOffset: offset }) };
    }

    return await publicSearchPage(
      ctx,
      "organizational",
      normalizedQuery,
      cursor?.publicCursor ? decodeBase64Url(cursor.publicCursor) : null,
      fingerprint,
      memberIds,
    );
  },
});

const chatResearchStoreValidator = v.object({
  jurisdictionId: v.id("jurisdictions"),
  name: v.string(),
  kind: v.union(v.literal("geographic"), v.literal("organizational")),
  relation: v.union(
    v.literal("selected"),
    v.literal("geographic_ancestor"),
    v.literal("organizational_geography"),
  ),
  storeName: v.string(),
});

const chatResearchStoresValidator = v.object({
  authorizedScopeSize: v.number(),
  stores: v.array(chatResearchStoreValidator),
  partialCoverage: v.boolean(),
});

export type ChatResearchStore = ResearchScopeItem & { storeName: string };
export type ChatResearchStores = {
  authorizedScopeSize: number;
  stores: ChatResearchStore[];
  partialCoverage: boolean;
};

export async function readyStoreName(
  ctx: QueryCtx,
  jurisdictionId: Id<"jurisdictions">,
): Promise<string | null> {
  const row = await ctx.db.get("jurisdictions", jurisdictionId);
  const storeName = row?.geminiFileSearchStoreName;
  if (
    !row
    || row.status !== "enabled"
    || row.providerSyncState !== "synced"
    || !storeName
    || !isGeminiFileSearchStoreName(storeName)
  ) return null;
  const owners = await ctx.db
    .query("jurisdictions")
    .withIndex("by_gemini_store_name", (q) => q.eq("geminiFileSearchStoreName", storeName))
    .take(2);
  return owners.length === 1 && owners[0]._id === row._id ? storeName : null;
}

export async function resolveChatResearchStoresForJurisdiction(
  ctx: QueryCtx,
  jurisdictionId: Id<"jurisdictions">,
): Promise<ChatResearchStores> {
  const scope = await resolveResearchScopeForJurisdiction(ctx, jurisdictionId);
  const storeNames = await Promise.all(
    scope.items.map(async (item) => await readyStoreName(ctx, item.jurisdictionId)),
  );
  if (!storeNames[0]) throw new ConvexError("CHAT_RESEARCH_STORE_NOT_READY");
  const stores = scope.items.flatMap((item, index) => {
    const storeName = storeNames[index];
    return storeName ? [{ ...item, storeName }] : [];
  });
  return {
    authorizedScopeSize: scope.items.length,
    stores,
    partialCoverage: stores.length !== scope.items.length,
  };
}

/** Private selected-first store resolution for the authenticated Next server route. */
export const resolveChatResearchStores = internalQuery({
  args: { jurisdictionId: v.string() },
  returns: chatResearchStoresValidator,
  handler: async (ctx, args): Promise<ChatResearchStores> => {
    const jurisdictionId = ctx.db.normalizeId("jurisdictions", args.jurisdictionId);
    if (!jurisdictionId) throw new ConvexError("JURISDICTION_ACCESS_DENIED");
    return await resolveChatResearchStoresForJurisdiction(ctx, jurisdictionId);
  },
});
