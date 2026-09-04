import { ConvexError, v } from "convex/values";
import { internalQuery, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import {
  isLegacyCountryCode,
  jurisdictionKindValidator,
  jurisdictionSearchPageValidator,
  MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS,
  MAX_SELECTOR_PAGE_SIZE,
  type JurisdictionKind,
  type ResearchScopeItem,
} from "./lib/jurisdictionDomain";
import { isPublicJurisdictionEligible } from "./lib/jurisdictionEligibility";
import { isGeminiFileSearchStoreName } from "./lib/geminiFileSearchNames";
import {
  activeOrganizationIdsForUser,
  assertJurisdictionAccess,
  getAccessibleJurisdictionById,
} from "./lib/jurisdictionAccess";
import { optionalUserId } from "./lib/requireUser";
import { readUnifiedJurisdictionsEnabled } from "./admin/featureFlags";
import { resolveResearchScopeForJurisdiction } from "./lib/researchScope";

const accessibleJurisdictionValidator = v.object({
  _id: v.id("jurisdictions"),
  name: v.string(),
  slug: v.string(),
  status: v.literal("enabled"),
  kind: v.union(v.literal("geographic"), v.literal("organizational")),
  visibility: v.union(v.literal("public"), v.literal("members")),
});

const searchJurisdictionValidator = v.union(
  v.null(),
  v.object({
    code: v.string(),
    name: v.string(),
    slug: v.string(),
    enabled: v.literal(true),
    isDefault: v.boolean(),
    searchReady: v.literal(true),
  }),
);

const publicJurisdictionListItemValidator = v.object({
  code: v.string(),
  name: v.string(),
  slug: v.string(),
  isDefault: v.boolean(),
});

// Admin validation currently accepts any two-letter code (26 × 26).
const MAX_PUBLIC_JURISDICTIONS = 26 * 26;
const MAX_SEARCH_QUERY_LENGTH = 120;
const MAX_RESEARCH_JURISDICTION_ID_LENGTH = 200;
const MAX_CURSOR_LENGTH = 4096;
const MAX_NESTED_CURSOR_LENGTH = 2048;

type SearchPhase = "members" | "public";
type SearchCursor = {
  v: 1;
  kind: JurisdictionKind;
  q: string;
  phase: SearchPhase;
  memberOffset?: number;
  publicCursor?: string | null;
};

type ResearchJurisdiction = {
  id: Id<"jurisdictions">;
  name: string;
  slug: string;
  kind: JurisdictionKind;
  isDefault: boolean;
  legacyCountryCode?: string;
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
  const allowed = new Set(["v", "kind", "q", "phase", "memberOffset", "publicCursor"]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) invalidCursor();
  if (
    candidate.v !== 1 ||
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
  return candidate as SearchCursor;
}

function projectResearchJurisdiction(row: Doc<"jurisdictions">): ResearchJurisdiction {
  const projected: ResearchJurisdiction = {
    id: row._id,
    name: row.name,
    slug: row.slug,
    kind: row.kind as JurisdictionKind,
    isDefault: row.isDefault,
  };
  if (isLegacyCountryCode(row.legacyCountryCode)) {
    projected.legacyCountryCode = row.legacyCountryCode;
  }
  return projected;
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
) {
  const paginationOptions = { numItems: MAX_SELECTOR_PAGE_SIZE, cursor: nestedCursor };
  const result = normalizedQuery
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
  await Promise.all(result.page.map((row) => assertTypedRelationship(ctx, row, kind)));
  return {
    page: result.page.map(projectResearchJurisdiction),
    group: kind === "geographic" ? ("geographic" as const) : ("public_organizations" as const),
    isDone: result.isDone,
    continueCursor: result.isDone
      ? null
      : encodeCursor({
          v: 1,
          kind,
          q: fingerprint,
          phase: "public",
          publicCursor: encodeBase64Url(result.continueCursor),
        }),
  };
}

async function memberOrganizationMatches(
  ctx: QueryCtx,
  userId: string,
  normalizedQuery: string,
): Promise<ResearchJurisdiction[]> {
  const organizationIds = await activeOrganizationIdsForUser(ctx, userId);
  const normalizedNeedle = normalizedQuery.toLocaleLowerCase("en");
  const candidates = await Promise.all(
    [...organizationIds].map(async (organizationId) => {
      const [organization, rows] = await Promise.all([
        ctx.db.get("organizations", organizationId),
        ctx.db
          .query("jurisdictions")
          .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
          .take(2),
      ]);
      if (!organization || organization.status !== "active" || rows.length > 1) {
        throw new ConvexError("JURISDICTION_SELECTOR_STATE_INVALID");
      }
      const row = rows[0];
      if (!row) return null;
      if (
        row.kind !== "organizational" ||
        row.organizationId !== organizationId ||
        row.status !== "enabled"
      ) {
        throw new ConvexError("JURISDICTION_SELECTOR_STATE_INVALID");
      }
      await assertTypedRelationship(ctx, row, "organizational");
      if (row.visibility !== "members") return null;
      const normalizedName = row.name.normalize("NFKC").toLocaleLowerCase("en");
      if (normalizedNeedle && !normalizedName.includes(normalizedNeedle)) return null;
      return projectResearchJurisdiction(row);
    }),
  );
  return candidates
    .filter((row): row is ResearchJurisdiction => row !== null)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function normalizeCode(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new ConvexError("INVALID_JURISDICTION_CODE");
  }
  return normalized;
}

/** Returns readiness without provider identity to protected server-side callers. */
export const getPublicByCode = internalQuery({
  args: { code: v.string() },
  returns: searchJurisdictionValidator,
  handler: async (ctx, args) => {
    const code = normalizeCode(args.code);
    const rows = await ctx.db
      .query("jurisdictions")
      .withIndex("by_code_and_status", (q) =>
        q.eq("code", code).eq("status", "enabled"),
      )
      .take(2);
    if (
      rows.length !== 1 ||
      !isLegacyCountryCode(rows[0].code) ||
      rows[0].code !== code ||
      !isPublicJurisdictionEligible(rows[0])
    ) {
      return null;
    }
    const jurisdiction = rows[0];
    return {
      code,
      name: jurisdiction.name,
      slug: jurisdiction.slug,
      enabled: true as const,
      isDefault: jurisdiction.isDefault,
      searchReady: true as const,
    };
  },
});

/** Lists the complete enabled ISO catalog used by public jurisdiction selectors. */
export const listPublicEnabled = query({
  args: {},
  returns: v.array(publicJurisdictionListItemValidator),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("jurisdictions")
      .withIndex("by_status_and_code", (q) =>
        q.eq("status", "enabled").gte("code", "AA").lte("code", "ZZ"),
      )
      .take(MAX_PUBLIC_JURISDICTIONS + 1);

    const legacyRows = rows.filter(
      (row): row is typeof row & { code: string } => isLegacyCountryCode(row.code),
    );
    // More legacy rows than possible two-letter codes proves corruption.
    // Code-less unified rows are intentionally invisible to this flag-off path.
    if (legacyRows.length > MAX_PUBLIC_JURISDICTIONS) return [];
    const enabledRowsByCode = new Map<string, number>();
    for (const row of legacyRows) {
      enabledRowsByCode.set(row.code, (enabledRowsByCode.get(row.code) ?? 0) + 1);
    }

    return legacyRows
      .filter(
        (row) =>
          enabledRowsByCode.get(row.code) === 1 &&
          isPublicJurisdictionEligible(row),
      )
      .map(({ code, name, slug, isDefault }) => ({ code, name, slug, isDefault }))
      .sort((left, right) =>
        Number(right.isDefault) - Number(left.isDefault) ||
        left.name.localeCompare(right.name) ||
        left.code.localeCompare(right.code),
      );
  },
});

const researchJurisdictionValidator = v.union(
  v.null(),
  v.object({
    id: v.id("jurisdictions"),
    name: v.string(),
    slug: v.string(),
    kind: jurisdictionKindValidator,
    isDefault: v.boolean(),
    legacyCountryCode: v.optional(v.string()),
  }),
);

/** Returns the safe jurisdiction projection when the caller has server-derived access. */
export const getAccessibleById = query({
  args: { id: v.id("jurisdictions") },
  returns: v.union(accessibleJurisdictionValidator, v.null()),
  handler: async (ctx, args) => await getAccessibleJurisdictionById(ctx, args.id),
});

/** Resolves the compatibility selector pair without exposing provider configuration. */
export const resolveResearchSelection = query({
  args: {
    jurisdictionId: v.optional(v.string()),
    country: v.optional(v.string()),
  },
  returns: researchJurisdictionValidator,
  handler: async (ctx, args) => {
    if (args.jurisdictionId === undefined && args.country === undefined) return null;
    if (
      args.jurisdictionId !== undefined
      && (args.jurisdictionId.length === 0
        || args.jurisdictionId.length > MAX_RESEARCH_JURISDICTION_ID_LENGTH)
    ) return null;
    let country: string | undefined;
    if (args.country !== undefined) {
      const normalized = args.country.trim().toUpperCase();
      if (!isLegacyCountryCode(normalized)) return null;
      country = normalized;
    }
    try {
      const jurisdictionId = args.jurisdictionId === undefined
        ? null
        : ctx.db.normalizeId("jurisdictions", args.jurisdictionId);
      if (args.jurisdictionId !== undefined && !jurisdictionId) return null;
      const byId = jurisdictionId
        ? await ctx.db.get("jurisdictions", jurisdictionId)
        : null;
      const codeRows = country
        ? await ctx.db
            .query("jurisdictions")
            .withIndex("by_legacyCountryCode_and_status", (q) =>
              q.eq("legacyCountryCode", country).eq("status", "enabled"),
            )
            .take(2)
        : [];
      if ((jurisdictionId && !byId) || (country && codeRows.length !== 1)) return null;
      const selected = byId ?? codeRows[0];
      if (!selected || (byId && country && codeRows[0]?._id !== byId._id)) return null;
      await assertJurisdictionAccess(ctx, selected);
      const kind = selected.kind;
      if (kind !== "geographic" && kind !== "organizational") return null;
      await assertTypedRelationship(ctx, selected, kind);
      const projected = projectResearchJurisdiction(selected);
      if (country && projected.legacyCountryCode !== country) return null;
      return projected;
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
    const fingerprint = await queryFingerprint(normalizedQuery);
    const userId = args.kind === "organizational" ? await optionalUserId(ctx) : null;
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
      const matches = await memberOrganizationMatches(ctx, userId, normalizedQuery);
      const offset = cursor?.memberOffset ?? 0;
      if (offset > matches.length) invalidCursor();
      const page = matches.slice(offset, offset + MAX_SELECTOR_PAGE_SIZE);
      if (page.length > 0) {
        const nextOffset = offset + page.length;
        return {
          page,
          group: "your_organizations" as const,
          isDone: false,
          continueCursor: encodeCursor(
            nextOffset < matches.length
              ? {
                  v: 1,
                  kind: "organizational",
                  q: fingerprint,
                  phase: "members",
                  memberOffset: nextOffset,
                }
              : {
                  v: 1,
                  kind: "organizational",
                  q: fingerprint,
                  phase: "public",
                  publicCursor: null,
                },
          ),
        };
      }
    }

    if (userId && cursor?.phase === "public") {
      await activeOrganizationIdsForUser(ctx, userId);
    }

    return await publicSearchPage(
      ctx,
      "organizational",
      normalizedQuery,
      cursor?.publicCursor ? decodeBase64Url(cursor.publicCursor) : null,
      fingerprint,
    );
  },
});

/** Exposes rollout readiness without revealing environment or flag records. */
export const isUnifiedJurisdictionsEnabled = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => await readUnifiedJurisdictionsEnabled(ctx),
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

async function readyStoreName(
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
