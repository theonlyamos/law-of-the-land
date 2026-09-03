import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import type { AdminRole } from "../lib/adminPermissions";
import { isGeminiFileSearchStoreName } from "../lib/geminiFileSearchNames";
import {
  MAX_GEOGRAPHIC_DEPTH,
  allowedParentLevelsByLevel,
  geographicLevelValidator,
  jurisdictionDocumentValidator,
  jurisdictionKindValidator,
  jurisdictionVisibilityValidator,
  normalizeGeographicAlias,
  normalizeJurisdictionSlug,
  normalizePlaceId,
  organizationClassValidator,
  organizationScopeModeValidator,
  organizationStatusValidator,
  projectJurisdictionKind,
  projectJurisdictionVisibility,
  type GeographicLevel,
} from "../lib/jurisdictionDomain";
import { verifyVerifiedPlaceClaim } from "../lib/placeClaim";
import { validateAuditReason, writeAudit } from "./audit";
import {
  requireEnabledAdminCatalogRead,
  requireEnabledAdminPermission,
} from "./featureFlags";

const MAX_TEXT_LENGTH = 300;
const MAX_SCOPE_LINKS = 8;
const MAX_PROFILE_ROWS = 2;
const MAX_ARCHIVAL_CHILD_SCAN = 100;
const MAX_GEOGRAPHIC_ALIASES = 20;
const MAX_CATALOG_PAGE_SIZE = 20;
const MAX_CATALOG_SEARCH_LENGTH = 100;
const MAX_CATALOG_ALIAS_LENGTH = 300;

const jurisdictionStatusValidator = v.union(
  v.literal("draft"),
  v.literal("enabled"),
  v.literal("archived"),
);
const providerSyncStateValidator = v.union(
  v.literal("pending"),
  v.literal("synced"),
  v.literal("drifted"),
  v.literal("failed"),
);
const geminiSetupStateValidator = v.union(
  v.literal("not_set_up"),
  v.literal("setting_up"),
  v.literal("ready"),
  v.literal("needs_review"),
  v.literal("setup_failed"),
);
const safeParentValidator = v.object({
  id: v.id("jurisdictions"),
  name: v.string(),
  level: geographicLevelValidator,
});
const geographicOptionValidator = v.object({
  id: v.id("jurisdictions"),
  name: v.string(),
  level: geographicLevelValidator,
  parent: v.union(v.null(), safeParentValidator),
});
const adminJurisdictionValidator = v.object({
  id: v.id("jurisdictions"),
  name: v.string(),
  slug: v.string(),
  status: jurisdictionStatusValidator,
  kind: jurisdictionKindValidator,
  visibility: jurisdictionVisibilityValidator,
  provider: v.object({
    syncState: providerSyncStateValidator,
    setupState: geminiSetupStateValidator,
    storeConfigured: v.boolean(),
    embeddingModel: v.optional(v.string()),
  }),
  migrationState: v.union(v.literal("typed"), v.literal("legacy")),
  geographic: v.union(v.null(), v.object({
    level: geographicLevelValidator,
    parent: v.union(v.null(), safeParentValidator),
  })),
  organization: v.union(v.null(), v.object({
    id: v.id("organizations"),
    name: v.string(),
    slug: v.string(),
    class: organizationClassValidator,
    status: organizationStatusValidator,
  })),
  scopeMode: v.union(v.null(), organizationScopeModeValidator),
});

type Actor = { userId: string; roles: AdminRole[] };

export const assertCanManageJurisdictions = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    return actor.userId;
  },
});

function requiredText(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_TEXT_LENGTH) throw new ConvexError(code);
  return normalized;
}

function placeSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return normalizeJurisdictionSlug(slug);
}

async function assertUniqueSlug(
  ctx: MutationCtx,
  slug: string,
  exceptId?: Id<"jurisdictions">,
): Promise<void> {
  const rows = await ctx.db
    .query("jurisdictions")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .take(2);
  if (rows.some((row) => row._id !== exceptId)) {
    throw new ConvexError("JURISDICTION_SLUG_EXISTS");
  }
}

async function assertUniquePlace(
  ctx: MutationCtx,
  placeId: string,
  exceptJurisdictionId?: Id<"jurisdictions">,
): Promise<void> {
  const rows = await ctx.db
    .query("geographicJurisdictions")
    .withIndex("by_googlePlaceId", (q) => q.eq("googlePlaceId", placeId))
    .take(2);
  if (rows.some((row) => row.jurisdictionId !== exceptJurisdictionId)) {
    throw new ConvexError("GOOGLE_PLACE_ID_EXISTS");
  }
}

async function geographicProfile(
  ctx: MutationCtx,
  jurisdictionId: Id<"jurisdictions">,
): Promise<Doc<"geographicJurisdictions"> | null> {
  const rows = await ctx.db
    .query("geographicJurisdictions")
    .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", jurisdictionId))
    .take(MAX_PROFILE_ROWS);
  if (rows.length > 1) throw new ConvexError("GEOGRAPHIC_PROFILE_STATE_INVALID");
  return rows[0] ?? null;
}

async function organizationalProfile(
  ctx: MutationCtx,
  jurisdictionId: Id<"jurisdictions">,
): Promise<Doc<"organizationalJurisdictions"> | null> {
  const rows = await ctx.db
    .query("organizationalJurisdictions")
    .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", jurisdictionId))
    .take(MAX_PROFILE_ROWS);
  if (rows.length > 1) throw new ConvexError("ORGANIZATIONAL_PROFILE_STATE_INVALID");
  return rows[0] ?? null;
}

/** Verifies that linking child to parent is acyclic and stays within eight nodes. */
export async function assertGeographicParentChain(
  ctx: MutationCtx,
  childId: Id<"jurisdictions">,
  parentId: Id<"jurisdictions">,
): Promise<void> {
  const visited = new Set<Id<"jurisdictions">>([childId]);
  let currentId: Id<"jurisdictions"> | undefined = parentId;
  let narrowerLevel: GeographicLevel | undefined;
  let immediateStateInvalid = false;
  let ancestorStateInvalid = false;
  let levelInvalid = false;
  let depth = 1;
  while (currentId !== undefined) {
    if (visited.has(currentId)) throw new ConvexError("GEOGRAPHIC_PARENT_CYCLE");
    visited.add(currentId);
    depth += 1;
    if (depth > MAX_GEOGRAPHIC_DEPTH) {
      throw new ConvexError("GEOGRAPHIC_DEPTH_EXCEEDED");
    }
    const [common, profile]: [
      Doc<"jurisdictions"> | null,
      Doc<"geographicJurisdictions"> | null,
    ] = await Promise.all([
      ctx.db.get("jurisdictions", currentId),
      geographicProfile(ctx, currentId),
    ]);
    const stateInvalid =
      !common ||
      common.status !== "enabled" ||
      projectJurisdictionKind(common) !== "geographic" ||
      !profile;
    if (stateInvalid) {
      if (currentId === parentId) immediateStateInvalid = true;
      else ancestorStateInvalid = true;
    }
    if (!profile) {
      throw new ConvexError(
        currentId === parentId
          ? "GEOGRAPHIC_PARENT_REQUIRED"
          : "GEOGRAPHIC_PARENT_CHAIN_INVALID",
      );
    }
    if (
      narrowerLevel !== undefined &&
      !allowedParentLevelsByLevel[narrowerLevel].includes(profile.level)
    ) {
      levelInvalid = true;
    }
    if (profile.parentJurisdictionId === undefined && profile.level !== "country") {
      ancestorStateInvalid = true;
    }
    narrowerLevel = profile.level;
    currentId = profile.parentJurisdictionId;
  }
  if (ancestorStateInvalid) throw new ConvexError("GEOGRAPHIC_PARENT_CHAIN_INVALID");
  if (immediateStateInvalid) throw new ConvexError("GEOGRAPHIC_PARENT_REQUIRED");
  if (levelInvalid) throw new ConvexError("GEOGRAPHIC_PARENT_LEVEL_INVALID");
}

async function assertGeographicParent(
  ctx: MutationCtx,
  childId: Id<"jurisdictions">,
  level: GeographicLevel,
  parentJurisdictionId: Id<"jurisdictions"> | undefined,
): Promise<void> {
  if (parentJurisdictionId !== undefined) {
    await assertGeographicParentChain(ctx, childId, parentJurisdictionId);
  }
  if (level === "country") {
    if (parentJurisdictionId !== undefined) {
      throw new ConvexError("GEOGRAPHIC_PARENT_LEVEL_INVALID");
    }
    return;
  }
  if (parentJurisdictionId === undefined) {
    throw new ConvexError("GEOGRAPHIC_PARENT_REQUIRED");
  }
  const [parent, profile] = await Promise.all([
    ctx.db.get("jurisdictions", parentJurisdictionId),
    geographicProfile(ctx, parentJurisdictionId),
  ]);
  if (!parent || parent.status !== "enabled" || !profile) {
    throw new ConvexError("GEOGRAPHIC_PARENT_REQUIRED");
  }
  if (!allowedParentLevelsByLevel[level].includes(profile.level)) {
    throw new ConvexError("GEOGRAPHIC_PARENT_LEVEL_INVALID");
  }
}

async function scopeLinks(
  ctx: MutationCtx,
  organizationalProfileId: Id<"organizationalJurisdictions">,
) {
  const rows = await ctx.db
    .query("organizationGeographicScopes")
    .withIndex("by_organizationalJurisdictionId_and_geographicJurisdictionId", (q) =>
      q.eq("organizationalJurisdictionId", organizationalProfileId),
    )
    .take(MAX_SCOPE_LINKS + 1);
  if (rows.length > MAX_SCOPE_LINKS) {
    throw new ConvexError("ORGANIZATIONAL_SCOPE_STATE_INVALID");
  }
  return rows;
}

/** Checks the persisted organization profile and all linked enabled geographies. */
export async function assertOrganizationalScope(
  ctx: MutationCtx,
  jurisdiction: Doc<"jurisdictions">,
): Promise<void> {
  if (projectJurisdictionKind(jurisdiction) !== "organizational") {
    throw new ConvexError("ORGANIZATIONAL_PROFILE_REQUIRED");
  }
  if (!jurisdiction.organizationId) throw new ConvexError("ORGANIZATION_REQUIRED");
  const [organization, profile] = await Promise.all([
    ctx.db.get("organizations", jurisdiction.organizationId),
    organizationalProfile(ctx, jurisdiction._id),
  ]);
  if (!organization || organization.status !== "active") {
    throw new ConvexError("ORGANIZATION_NOT_AVAILABLE");
  }
  if (!profile) throw new ConvexError("ORGANIZATIONAL_PROFILE_REQUIRED");
  const links = await scopeLinks(ctx, profile._id);
  if (
    (profile.scopeMode === "global" && links.length !== 0) ||
    (profile.scopeMode === "linked_geographies" && links.length === 0)
  ) {
    throw new ConvexError("INVALID_SCOPE_MODE");
  }
  if (new Set(links.map((link) => link.geographicJurisdictionId)).size !== links.length) {
    throw new ConvexError("ORGANIZATIONAL_SCOPE_STATE_INVALID");
  }
  await Promise.all(links.map(async (link) => {
    const geographic = await ctx.db.get(
      "geographicJurisdictions",
      link.geographicJurisdictionId,
    );
    if (!geographic) throw new ConvexError("GEOGRAPHIC_SCOPE_INVALID");
    const common = await ctx.db.get("jurisdictions", geographic.jurisdictionId);
    if (!common || common.status !== "enabled" || projectJurisdictionKind(common) !== "geographic") {
      throw new ConvexError("GEOGRAPHIC_SCOPE_INVALID");
    }
    return geographic;
  }));
}

async function resolveScopeProfiles(
  ctx: MutationCtx,
  scopeMode: "global" | "linked_geographies",
  jurisdictionIds: Id<"jurisdictions">[],
): Promise<Doc<"geographicJurisdictions">[]> {
  if (
    jurisdictionIds.length > MAX_SCOPE_LINKS ||
    new Set(jurisdictionIds).size !== jurisdictionIds.length ||
    (scopeMode === "global" && jurisdictionIds.length !== 0) ||
    (scopeMode === "linked_geographies" && jurisdictionIds.length === 0)
  ) {
    throw new ConvexError("INVALID_SCOPE_MODE");
  }
  return await Promise.all(jurisdictionIds.map(async (jurisdictionId) => {
    const [common, profile] = await Promise.all([
      ctx.db.get("jurisdictions", jurisdictionId),
      geographicProfile(ctx, jurisdictionId),
    ]);
    if (
      !common ||
      common.status !== "enabled" ||
      projectJurisdictionKind(common) !== "geographic" ||
      !profile
    ) {
      throw new ConvexError("GEOGRAPHIC_SCOPE_INVALID");
    }
    return profile;
  }));
}

async function auditJurisdiction(
  ctx: MutationCtx,
  actor: Actor,
  input: {
    action: string;
    targetId: Id<"jurisdictions">;
    reason: string;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  await writeAudit(ctx, {
    actorId: actor.userId,
    actorRoles: actor.roles,
    action: input.action,
    targetType: "jurisdiction",
    targetId: input.targetId,
    reason: input.reason,
    beforeSummary: JSON.stringify(input.before ?? null),
    afterSummary: JSON.stringify(input.after ?? null),
    correlationId: `op_${crypto.randomUUID().replaceAll("-", "")}`,
    outcome: "success",
  });
}

/** The sole client-return projection: provider identities remain server-only. */
function projectClientJurisdiction(row: Doc<"jurisdictions">) {
  return {
    _id: row._id,
    _creationTime: row._creationTime,
    ...(row.code === undefined ? {} : { code: row.code }),
    name: row.name,
    slug: row.slug,
    status: row.status,
    isDefault: row.isDefault,
    providerSyncState: row.providerSyncState,
    ...(row.kind === undefined ? {} : { kind: row.kind }),
    ...(row.visibility === undefined ? {} : { visibility: row.visibility }),
    ...(row.organizationId === undefined ? {} : { organizationId: row.organizationId }),
    ...(row.legacyCountryCode === undefined ? {} : { legacyCountryCode: row.legacyCountryCode }),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function jurisdictionSnapshot(row: Doc<"jurisdictions"> | Omit<Doc<"jurisdictions">, "_id" | "_creationTime">) {
  return {
    code: row.code ?? null,
    name: row.name,
    slug: row.slug,
    status: row.status,
    isDefault: row.isDefault,
    geminiFileSearchStoreName: row.geminiFileSearchStoreName ?? null,
    geminiEmbeddingModel: row.geminiEmbeddingModel ?? null,
    providerSyncState: row.providerSyncState,
    kind: row.kind ?? null,
    visibility: row.visibility ?? null,
    organizationId: row.organizationId ?? null,
    legacyCountryCode: row.legacyCountryCode ?? null,
  };
}

function geographicJurisdictionSnapshot(
  common: Doc<"jurisdictions"> | Omit<Doc<"jurisdictions">, "_id" | "_creationTime">,
  profile: Pick<
    Doc<"geographicJurisdictions">,
    "googlePlaceId" | "level" | "countryCode" | "parentJurisdictionId"
  >,
  aliases: readonly string[],
) {
  return {
    common: jurisdictionSnapshot(common),
    geographic: {
      googlePlaceId: profile.googlePlaceId,
      level: profile.level,
      countryCode: profile.countryCode ?? null,
      parentJurisdictionId: profile.parentJurisdictionId ?? null,
      aliases: [...aliases].sort(),
    },
  };
}

function organizationalJurisdictionSnapshot(
  common: Doc<"jurisdictions"> | Omit<Doc<"jurisdictions">, "_id" | "_creationTime">,
  profile: Pick<Doc<"organizationalJurisdictions">, "scopeMode">,
  linkedProfiles: readonly Pick<Doc<"geographicJurisdictions">, "jurisdictionId">[],
) {
  return {
    common: jurisdictionSnapshot(common),
    organizational: {
      scopeMode: profile.scopeMode,
      geographicJurisdictionIds: linkedProfiles
        .map((linked) => linked.jurisdictionId)
        .sort(),
    },
  };
}

async function geographicAliasesForAudit(
  ctx: MutationCtx,
  jurisdictionId: Id<"jurisdictions">,
): Promise<Doc<"geographicJurisdictionAliases">[]> {
  const aliases = await ctx.db
    .query("geographicJurisdictionAliases")
    .withIndex("by_jurisdictionId_and_normalizedAlias", (q) =>
      q.eq("jurisdictionId", jurisdictionId),
    )
    .take(MAX_GEOGRAPHIC_ALIASES + 1);
  if (aliases.length > MAX_GEOGRAPHIC_ALIASES) {
    throw new ConvexError("GEOGRAPHIC_ALIAS_STATE_INVALID");
  }
  return aliases;
}

async function linkedProfilesForAudit(
  ctx: MutationCtx,
  links: readonly Doc<"organizationGeographicScopes">[],
): Promise<Doc<"geographicJurisdictions">[]> {
  return await Promise.all(links.map(async (link) => {
    const profile = await ctx.db.get(
      "geographicJurisdictions",
      link.geographicJurisdictionId,
    );
    if (!profile) throw new ConvexError("ORGANIZATIONAL_SCOPE_STATE_INVALID");
    return profile;
  }));
}

async function completeJurisdictionSnapshot(
  ctx: MutationCtx,
  common: Doc<"jurisdictions">,
) {
  if (projectJurisdictionKind(common) === "organizational") {
    const profile = await organizationalProfile(ctx, common._id);
    if (!profile) return { common: jurisdictionSnapshot(common) };
    const links = await scopeLinks(ctx, profile._id);
    return organizationalJurisdictionSnapshot(
      common,
      profile,
      await linkedProfilesForAudit(ctx, links),
    );
  }
  const profile = await geographicProfile(ctx, common._id);
  if (!profile) {
    return common.kind === undefined
      ? jurisdictionSnapshot(common)
      : { common: jurisdictionSnapshot(common) };
  }
  const aliases = await geographicAliasesForAudit(ctx, common._id);
  return geographicJurisdictionSnapshot(
    common,
    profile,
    aliases.map((alias) => alias.normalizedAlias),
  );
}

function withUpdatedCommonSnapshot(
  snapshot: unknown,
  common: Doc<"jurisdictions">,
) {
  const updatedCommon = jurisdictionSnapshot(common);
  if (snapshot !== null && typeof snapshot === "object" && "common" in snapshot) {
    return { ...snapshot, common: updatedCommon };
  }
  return updatedCommon;
}

function normalizeLegacyCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new ConvexError("INVALID_JURISDICTION_CODE");
  return code;
}

async function assertDefaultAvailable(
  ctx: MutationCtx,
  exceptId?: Id<"jurisdictions">,
): Promise<void> {
  const defaults = await ctx.db
    .query("jurisdictions")
    .withIndex("by_isDefault", (q) => q.eq("isDefault", true))
    .take(2);
  if (defaults.some((row) => row._id !== exceptId && row.status !== "archived")) {
    throw new ConvexError("DEFAULT_JURISDICTION_EXISTS");
  }
}

export async function createLegacyJurisdictionForActor(
  ctx: MutationCtx,
  actor: Actor,
  args: {
    code: string;
    name: string;
    slug: string;
    isDefault: boolean;
  },
  reason: string,
): Promise<Id<"jurisdictions">> {
  const code = normalizeLegacyCode(args.code);
  const slug = normalizeJurisdictionSlug(args.slug);
  const [codes] = await Promise.all([
    ctx.db.query("jurisdictions").withIndex("by_code", (q) => q.eq("code", code)).take(2),
    assertUniqueSlug(ctx, slug),
  ]);
  if (codes.length > 0) throw new ConvexError("JURISDICTION_CODE_EXISTS");
  if (args.isDefault) await assertDefaultAvailable(ctx);
  const now = Date.now();
  const row = {
    code,
    name: requiredText(args.name, "INVALID_JURISDICTION_NAME"),
    slug,
    status: "draft" as const,
    isDefault: args.isDefault,
    providerSyncState: "pending" as const,
    createdBy: actor.userId,
    updatedBy: actor.userId,
    createdAt: now,
    updatedAt: now,
  };
  const id = await ctx.db.insert("jurisdictions", row);
  await auditJurisdiction(ctx, actor, {
    action: "jurisdiction.created",
    targetId: id,
    reason,
    after: jurisdictionSnapshot(row),
  });
  return id;
}

export async function updateLegacyJurisdictionForActor(
  ctx: MutationCtx,
  actor: Actor,
  args: {
    id: Id<"jurisdictions">;
    name: string;
    slug: string;
    isDefault: boolean;
  },
  reason: string,
): Promise<Doc<"jurisdictions">> {
  const row = await ctx.db.get("jurisdictions", args.id);
  if (!row || row.kind !== undefined || !row.code || !/^[A-Z]{2}$/.test(row.code)) {
    throw new ConvexError("JURISDICTION_NOT_FOUND");
  }
  if (row.status === "archived") throw new ConvexError("JURISDICTION_ARCHIVED");
  const slug = normalizeJurisdictionSlug(args.slug);
  await assertUniqueSlug(ctx, slug, row._id);
  if (args.isDefault) await assertDefaultAvailable(ctx, row._id);
  const patch = {
    name: requiredText(args.name, "INVALID_JURISDICTION_NAME"),
    slug,
    isDefault: args.isDefault,
    updatedBy: actor.userId,
    updatedAt: Date.now(),
  };
  await ctx.db.patch(row._id, patch);
  await auditJurisdiction(ctx, actor, {
    action: "jurisdiction.updated",
    targetId: row._id,
    reason,
    before: jurisdictionSnapshot(row),
    after: jurisdictionSnapshot({ ...row, ...patch }),
  });
  return { ...row, ...patch };
}

const geographicMutationArgs = {
  verifiedPlaceClaim: v.string(),
  level: geographicLevelValidator,
  parentJurisdictionId: v.optional(v.id("jurisdictions")),
  reason: v.string(),
} as const;

function validateCatalogPageSize(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_CATALOG_PAGE_SIZE) {
    throw new ConvexError("INVALID_ADMIN_PAGINATION");
  }
}

function normalizeCatalogSearch(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  if (normalized.length < 2 || normalized.length > MAX_CATALOG_SEARCH_LENGTH) {
    throw new ConvexError("INVALID_ADMIN_SEARCH_QUERY");
  }
  return normalized;
}

function invalidAdminJurisdictionProjection(): never {
  throw new ConvexError("ADMIN_JURISDICTION_PROJECTION_INVALID");
}

function geminiSetupState(row: Doc<"jurisdictions">) {
  if (row.providerSyncState === "drifted") return "needs_review" as const;
  if (row.providerSyncState === "failed") return "setup_failed" as const;
  if (
    row.providerSyncState === "synced" &&
    row.geminiFileSearchStoreName !== undefined &&
    isGeminiFileSearchStoreName(row.geminiFileSearchStoreName)
  ) return "ready" as const;
  if (row.geminiEmbeddingModel !== undefined) return "setting_up" as const;
  return "not_set_up" as const;
}

function assertTypedGeographicCommon(row: Doc<"jurisdictions">): void {
  if (
    row.kind !== "geographic" ||
    row.visibility !== "public" ||
    row.organizationId !== undefined
  ) {
    invalidAdminJurisdictionProjection();
  }
}

async function loadRequiredGeographicProfiles(
  ctx: QueryCtx,
  rows: readonly Doc<"jurisdictions">[],
): Promise<Map<Id<"jurisdictions">, Doc<"geographicJurisdictions">>> {
  const entries = await Promise.all(rows.map(async (row) => {
    const profiles = await ctx.db
      .query("geographicJurisdictions")
      .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", row._id))
      .take(2);
    if (profiles.length !== 1) invalidAdminJurisdictionProjection();
    return [row._id, profiles[0]] as const;
  }));
  return new Map(entries);
}

async function loadRequiredOrganizationalProfiles(
  ctx: QueryCtx,
  rows: readonly Doc<"jurisdictions">[],
): Promise<Map<Id<"jurisdictions">, Doc<"organizationalJurisdictions">>> {
  const entries = await Promise.all(rows.map(async (row) => {
    const profiles = await ctx.db
      .query("organizationalJurisdictions")
      .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", row._id))
      .take(2);
    if (profiles.length !== 1) invalidAdminJurisdictionProjection();
    return [row._id, profiles[0]] as const;
  }));
  return new Map(entries);
}

type SafeParent = {
  id: Id<"jurisdictions">;
  name: string;
  level: GeographicLevel;
};

async function resolveSafeGeographicParents(
  ctx: QueryCtx,
  profiles: ReadonlyMap<Id<"jurisdictions">, Doc<"geographicJurisdictions">>,
): Promise<Map<Id<"jurisdictions">, SafeParent>> {
  const parentIds = [...new Set(
    [...profiles.values()].flatMap((profile) =>
      profile.parentJurisdictionId === undefined ? [] : [profile.parentJurisdictionId],
    ),
  )];
  const parentRows = await Promise.all(parentIds.map(async (parentId) => {
    const [common, parentProfiles] = await Promise.all([
      ctx.db.get("jurisdictions", parentId),
      ctx.db
        .query("geographicJurisdictions")
        .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", parentId))
        .take(2),
    ]);
    if (
      !common ||
      common.status !== "enabled" ||
      parentProfiles.length !== 1
    ) {
      invalidAdminJurisdictionProjection();
    }
    assertTypedGeographicCommon(common);
    return [parentId, { id: parentId, name: common.name, level: parentProfiles[0].level }] as const;
  }));
  const parents = new Map(parentRows);
  for (const profile of profiles.values()) {
    if (profile.level === "country") {
      if (profile.parentJurisdictionId !== undefined) invalidAdminJurisdictionProjection();
      continue;
    }
    if (profile.parentJurisdictionId === undefined) invalidAdminJurisdictionProjection();
    const parent = parents.get(profile.parentJurisdictionId);
    if (!parent || !allowedParentLevelsByLevel[profile.level].includes(parent.level)) {
      invalidAdminJurisdictionProjection();
    }
  }
  return parents;
}

function geographicOption(
  row: Doc<"jurisdictions">,
  profile: Doc<"geographicJurisdictions">,
  parents: ReadonlyMap<Id<"jurisdictions">, SafeParent>,
) {
  return {
    id: row._id,
    name: row.name,
    level: profile.level,
    parent: profile.parentJurisdictionId === undefined
      ? null
      : (parents.get(profile.parentJurisdictionId) ?? invalidAdminJurisdictionProjection()),
  };
}

export const listGeographicJurisdictionOptions = query({
  args: {
    purpose: v.union(v.literal("parent"), v.literal("linked_scope")),
    childLevel: v.optional(geographicLevelValidator),
    query: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(geographicOptionValidator),
  handler: async (ctx, args) => {
    await requireEnabledAdminCatalogRead(ctx, "jurisdiction");
    validateCatalogPageSize(args.paginationOpts.numItems);
    if (
      (args.purpose === "parent" && args.childLevel === undefined) ||
      (args.purpose === "linked_scope" && args.childLevel !== undefined)
    ) {
      throw new ConvexError("INVALID_GEOGRAPHIC_OPTION_REQUEST");
    }
    const search = normalizeCatalogSearch(args.query);
    const result = search === undefined
      ? await ctx.db
          .query("jurisdictions")
          .withIndex("by_kind_and_status_and_name", (q) =>
            q.eq("kind", "geographic").eq("status", "enabled"),
          )
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("jurisdictions")
          .withSearchIndex("search_name", (q) =>
            q.search("name", search).eq("kind", "geographic").eq("status", "enabled"),
          )
          .paginate(args.paginationOpts);
    for (const row of result.page) assertTypedGeographicCommon(row);
    const profiles = await loadRequiredGeographicProfiles(ctx, result.page);
    const parents = await resolveSafeGeographicParents(ctx, profiles);
    const eligibleRows = args.purpose === "linked_scope"
      ? result.page
      : result.page.filter((row) =>
          allowedParentLevelsByLevel[args.childLevel!].includes(profiles.get(row._id)!.level),
        );
    return {
      ...result,
      page: eligibleRows.map((row) =>
        geographicOption(row, profiles.get(row._id)!, parents),
      ),
    };
  },
});

export const suggestGeographicParentsByAliases = query({
  args: {
    childLevel: geographicLevelValidator,
    aliases: v.array(v.string()),
  },
  returns: v.array(geographicOptionValidator),
  handler: async (ctx, args) => {
    await requireEnabledAdminCatalogRead(ctx, "jurisdiction");
    if (args.aliases.length > MAX_GEOGRAPHIC_ALIASES) {
      throw new ConvexError("INVALID_GEOGRAPHIC_ALIASES");
    }
    const normalizedAliases: string[] = [];
    const seenAliases = new Set<string>();
    for (const alias of args.aliases) {
      const normalized = normalizeGeographicAlias(alias);
      if (
        alias.length > MAX_CATALOG_ALIAS_LENGTH ||
        !normalized ||
        normalized.length > MAX_CATALOG_ALIAS_LENGTH
      ) {
        throw new ConvexError("INVALID_GEOGRAPHIC_ALIASES");
      }
      if (seenAliases.has(normalized)) continue;
      seenAliases.add(normalized);
      normalizedAliases.push(normalized);
    }
    const aliasRows = await Promise.all(normalizedAliases.map((normalizedAlias) =>
      ctx.db
        .query("geographicJurisdictionAliases")
        .withIndex("by_normalizedAlias", (q) => q.eq("normalizedAlias", normalizedAlias))
        .take(2),
    ));
    const candidateIds = [...new Set(
      aliasRows.flat().map((row) => row.jurisdictionId),
    )];
    const candidates = (await Promise.all(
      candidateIds.map((id) => ctx.db.get("jurisdictions", id)),
    )).filter((row): row is Doc<"jurisdictions"> =>
      row !== null && row.kind === "geographic" && row.status === "enabled",
    );
    for (const row of candidates) assertTypedGeographicCommon(row);
    const profiles = await loadRequiredGeographicProfiles(ctx, candidates);
    const eligible = candidates.filter((row) =>
      allowedParentLevelsByLevel[args.childLevel].includes(profiles.get(row._id)!.level),
    ).slice(0, MAX_GEOGRAPHIC_ALIASES);
    const eligibleProfiles = new Map(
      eligible.map((row) => [row._id, profiles.get(row._id)!] as const),
    );
    const parents = await resolveSafeGeographicParents(ctx, eligibleProfiles);
    return eligible.map((row) =>
      geographicOption(row, eligibleProfiles.get(row._id)!, parents),
    );
  },
});

export const listAdminJurisdictions = query({
  args: {
    status: v.optional(jurisdictionStatusValidator),
    kind: v.optional(jurisdictionKindValidator),
    query: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(adminJurisdictionValidator),
  handler: async (ctx, args) => {
    await requireEnabledAdminCatalogRead(ctx, "jurisdiction");
    validateCatalogPageSize(args.paginationOpts.numItems);
    const search = normalizeCatalogSearch(args.query);
    const result = search !== undefined
      ? args.kind !== undefined && args.status !== undefined
        ? await ctx.db.query("jurisdictions").withSearchIndex("search_name", (q) =>
            q.search("name", search).eq("kind", args.kind!).eq("status", args.status!),
          ).paginate(args.paginationOpts)
        : args.kind !== undefined
          ? await ctx.db.query("jurisdictions").withSearchIndex("search_name", (q) =>
              q.search("name", search).eq("kind", args.kind!),
            ).paginate(args.paginationOpts)
          : args.status !== undefined
            ? await ctx.db.query("jurisdictions").withSearchIndex("search_name", (q) =>
                q.search("name", search).eq("status", args.status!),
              ).paginate(args.paginationOpts)
            : await ctx.db.query("jurisdictions").withSearchIndex("search_name", (q) =>
                q.search("name", search),
              ).paginate(args.paginationOpts)
      : args.kind !== undefined && args.status !== undefined
        ? await ctx.db.query("jurisdictions").withIndex(
            "by_kind_and_status_and_name",
            (q) => q.eq("kind", args.kind!).eq("status", args.status!),
          ).paginate(args.paginationOpts)
        : args.kind !== undefined
          ? await ctx.db.query("jurisdictions").withIndex(
              "by_kind_and_name",
              (q) => q.eq("kind", args.kind!),
            ).paginate(args.paginationOpts)
          : args.status !== undefined
            ? await ctx.db.query("jurisdictions").withIndex(
                "by_status_and_name",
                (q) => q.eq("status", args.status!),
              ).paginate(args.paginationOpts)
            : await ctx.db.query("jurisdictions").withIndex("by_name").paginate(
                args.paginationOpts,
              );

    const geographicRows = result.page.filter((row) => row.kind === "geographic");
    const organizationalRows = result.page.filter((row) => row.kind === "organizational");
    const legacyRows = result.page.filter((row) => row.kind === undefined);
    for (const row of legacyRows) {
      if (row.visibility !== undefined || row.organizationId !== undefined) {
        invalidAdminJurisdictionProjection();
      }
    }
    for (const row of geographicRows) assertTypedGeographicCommon(row);
    for (const row of organizationalRows) {
      if (row.visibility === undefined || row.organizationId === undefined) {
        invalidAdminJurisdictionProjection();
      }
    }
    const [geographicProfiles, organizationalProfiles] = await Promise.all([
      loadRequiredGeographicProfiles(ctx, geographicRows),
      loadRequiredOrganizationalProfiles(ctx, organizationalRows),
    ]);
    const parents = await resolveSafeGeographicParents(ctx, geographicProfiles);
    const organizationIds = [...new Set(
      organizationalRows.map((row) => row.organizationId!),
    )];
    const organizations = new Map(await Promise.all(organizationIds.map(async (id) => {
      const organization = await ctx.db.get("organizations", id);
      if (!organization) invalidAdminJurisdictionProjection();
      return [id, organization] as const;
    })));

    return {
      ...result,
      page: result.page.map((row) => {
        const base = {
          id: row._id,
          name: row.name,
          slug: row.slug,
          status: row.status,
          kind: projectJurisdictionKind(row),
          visibility: projectJurisdictionVisibility(row),
          provider: {
            syncState: row.providerSyncState,
            setupState: geminiSetupState(row),
            storeConfigured: Boolean(
              row.geminiFileSearchStoreName && isGeminiFileSearchStoreName(row.geminiFileSearchStoreName),
            ),
            ...(row.geminiEmbeddingModel === undefined
              ? {}
              : { embeddingModel: row.geminiEmbeddingModel }),
          },
        };
        if (row.kind === undefined) {
          return {
            ...base,
            migrationState: "legacy" as const,
            geographic: null,
            organization: null,
            scopeMode: null,
          };
        }
        if (row.kind === "geographic") {
          const profile = geographicProfiles.get(row._id) ?? invalidAdminJurisdictionProjection();
          return {
            ...base,
            migrationState: "typed" as const,
            geographic: {
              level: profile.level,
              parent: profile.parentJurisdictionId === undefined
                ? null
                : (parents.get(profile.parentJurisdictionId) ??
                  invalidAdminJurisdictionProjection()),
            },
            organization: null,
            scopeMode: null,
          };
        }
        const profile = organizationalProfiles.get(row._id) ??
          invalidAdminJurisdictionProjection();
        const organization = organizations.get(row.organizationId!) ??
          invalidAdminJurisdictionProjection();
        return {
          ...base,
          migrationState: "typed" as const,
          geographic: null,
          organization: {
            id: organization._id,
            name: organization.name,
            slug: organization.slug,
            class: organization.class,
            status: organization.status,
          },
          scopeMode: profile.scopeMode,
        };
      }),
    };
  },
});

export const createGeographicJurisdiction = mutation({
  args: geographicMutationArgs,
  returns: v.id("jurisdictions"),
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    const reason = validateAuditReason(args.reason);
    const place = await verifyVerifiedPlaceClaim(args.verifiedPlaceClaim, actor.userId);
    if (args.level === "country" && place.countryCode === undefined) {
      throw new ConvexError("INVALID_COUNTRY_CODE");
    }
    const placeId = normalizePlaceId(place.googlePlaceId);
    const slug = placeSlug(place.name);
    await Promise.all([assertUniquePlace(ctx, placeId), assertUniqueSlug(ctx, slug)]);
    const now = Date.now();
    const id = await ctx.db.insert("jurisdictions", {
      name: place.name,
      slug,
      status: "draft",
      isDefault: false,
      providerSyncState: "pending",
      kind: "geographic",
      visibility: "public",
      legacyCountryCode: args.level === "country" ? place.countryCode : undefined,
      createdBy: actor.userId,
      updatedBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    });
    await assertGeographicParent(ctx, id, args.level, args.parentJurisdictionId);
    await ctx.db.insert("geographicJurisdictions", {
      jurisdictionId: id,
      googlePlaceId: placeId,
      level: args.level,
      countryCode: place.countryCode,
      latitude: place.latitude,
      longitude: place.longitude,
      formattedAddress: place.formattedAddress,
      parentJurisdictionId: args.parentJurisdictionId,
      createdAt: now,
      updatedAt: now,
    });
    for (const alias of place.aliases) {
      await ctx.db.insert("geographicJurisdictionAliases", {
        jurisdictionId: id,
        normalizedAlias: alias,
        source: "google_places",
        createdAt: now,
      });
    }
    const created = await ctx.db.get("jurisdictions", id);
    if (!created) throw new ConvexError("JURISDICTION_NOT_FOUND");
    await auditJurisdiction(ctx, actor, {
      action: "jurisdiction.geographic_created",
      targetId: id,
      reason,
      after: geographicJurisdictionSnapshot(
        created,
        {
          googlePlaceId: placeId,
          level: args.level,
          countryCode: place.countryCode,
          parentJurisdictionId: args.parentJurisdictionId,
        },
        place.aliases,
      ),
    });
    return id;
  },
});

export const updateGeographicJurisdiction = mutation({
  args: { id: v.id("jurisdictions"), ...geographicMutationArgs },
  returns: jurisdictionDocumentValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    const reason = validateAuditReason(args.reason);
    const [row, profile] = await Promise.all([
      ctx.db.get("jurisdictions", args.id),
      geographicProfile(ctx, args.id),
    ]);
    if (!row || !profile || projectJurisdictionKind(row) !== "geographic") {
      throw new ConvexError("JURISDICTION_NOT_FOUND");
    }
    if (row.status === "archived") throw new ConvexError("JURISDICTION_ARCHIVED");
    const place = await verifyVerifiedPlaceClaim(args.verifiedPlaceClaim, actor.userId);
    if (args.level === "country" && place.countryCode === undefined) {
      throw new ConvexError("INVALID_COUNTRY_CODE");
    }
    const placeId = normalizePlaceId(place.googlePlaceId);
    const slug = placeSlug(place.name);
    await Promise.all([
      assertUniquePlace(ctx, placeId, row._id),
      assertUniqueSlug(ctx, slug, row._id),
      assertGeographicParent(ctx, row._id, args.level, args.parentJurisdictionId),
    ]);
    if (
      profile.level !== args.level ||
      profile.parentJurisdictionId !== args.parentJurisdictionId
    ) {
      const children = await ctx.db
        .query("geographicJurisdictions")
        .withIndex("by_parentJurisdictionId", (q) => q.eq("parentJurisdictionId", row._id))
        .take(1);
      if (children.length > 0) throw new ConvexError("GEOGRAPHIC_CHILDREN_EXIST");
    }
    const aliases = await geographicAliasesForAudit(ctx, row._id);
    const beforeSnapshot = geographicJurisdictionSnapshot(
      row,
      profile,
      aliases.map((alias) => alias.normalizedAlias),
    );
    const now = Date.now();
    const patch = {
      name: place.name,
      slug,
      legacyCountryCode: args.level === "country" ? place.countryCode : undefined,
      updatedBy: actor.userId,
      updatedAt: now,
    };
    await ctx.db.patch(row._id, patch);
    await ctx.db.patch(profile._id, {
      googlePlaceId: placeId,
      level: args.level,
      countryCode: place.countryCode,
      latitude: place.latitude,
      longitude: place.longitude,
      formattedAddress: place.formattedAddress,
      parentJurisdictionId: args.parentJurisdictionId,
      updatedAt: now,
    });
    for (const alias of aliases) await ctx.db.delete(alias._id);
    for (const alias of place.aliases) {
      await ctx.db.insert("geographicJurisdictionAliases", {
        jurisdictionId: row._id,
        normalizedAlias: alias,
        source: "google_places",
        createdAt: now,
      });
    }
    await auditJurisdiction(ctx, actor, {
      action: "jurisdiction.geographic_updated",
      targetId: row._id,
      reason,
      before: beforeSnapshot,
      after: geographicJurisdictionSnapshot(
        { ...row, ...patch },
        {
          googlePlaceId: placeId,
          level: args.level,
          countryCode: place.countryCode,
          parentJurisdictionId: args.parentJurisdictionId,
        },
        place.aliases,
      ),
    });
    return projectClientJurisdiction({ ...row, ...patch });
  },
});

const organizationalMutationArgs = {
  visibility: jurisdictionVisibilityValidator,
  scopeMode: organizationScopeModeValidator,
  geographicJurisdictionIds: v.array(v.id("jurisdictions")),
  reason: v.string(),
} as const;

export const createOrganizationalJurisdiction = mutation({
  args: { organizationId: v.id("organizations"), ...organizationalMutationArgs },
  returns: v.id("jurisdictions"),
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    const reason = validateAuditReason(args.reason);
    const organization = await ctx.db.get("organizations", args.organizationId);
    if (!organization || organization.status !== "active") {
      throw new ConvexError("ORGANIZATION_NOT_AVAILABLE");
    }
    const existing = await ctx.db
      .query("jurisdictions")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organization._id))
      .take(2);
    if (existing.length > 0) throw new ConvexError("ORGANIZATION_JURISDICTION_EXISTS");
    await assertUniqueSlug(ctx, organization.slug);
    const profiles = await resolveScopeProfiles(
      ctx,
      args.scopeMode,
      args.geographicJurisdictionIds,
    );
    const now = Date.now();
    const id = await ctx.db.insert("jurisdictions", {
      name: organization.name,
      slug: organization.slug,
      status: "draft",
      isDefault: false,
      providerSyncState: "pending",
      kind: "organizational",
      visibility: args.visibility,
      organizationId: organization._id,
      createdBy: actor.userId,
      updatedBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    });
    const profileId = await ctx.db.insert("organizationalJurisdictions", {
      jurisdictionId: id,
      scopeMode: args.scopeMode,
      createdAt: now,
      updatedAt: now,
    });
    for (const profile of profiles) {
      await ctx.db.insert("organizationGeographicScopes", {
        organizationalJurisdictionId: profileId,
        geographicJurisdictionId: profile._id,
        createdAt: now,
      });
    }
    const created = await ctx.db.get("jurisdictions", id);
    if (!created) throw new ConvexError("JURISDICTION_NOT_FOUND");
    await auditJurisdiction(ctx, actor, {
      action: "jurisdiction.organizational_created",
      targetId: id,
      reason,
      after: organizationalJurisdictionSnapshot(
        created,
        { scopeMode: args.scopeMode },
        profiles,
      ),
    });
    return id;
  },
});

export const updateOrganizationalJurisdiction = mutation({
  args: { id: v.id("jurisdictions"), ...organizationalMutationArgs },
  returns: jurisdictionDocumentValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    const reason = validateAuditReason(args.reason);
    const [row, profile] = await Promise.all([
      ctx.db.get("jurisdictions", args.id),
      organizationalProfile(ctx, args.id),
    ]);
    if (!row || !profile || projectJurisdictionKind(row) !== "organizational") {
      throw new ConvexError("JURISDICTION_NOT_FOUND");
    }
    if (row.status === "archived") throw new ConvexError("JURISDICTION_ARCHIVED");
    if (!row.organizationId) throw new ConvexError("ORGANIZATION_REQUIRED");
    const organization = await ctx.db.get("organizations", row.organizationId);
    if (!organization || organization.status !== "active") {
      throw new ConvexError("ORGANIZATION_NOT_AVAILABLE");
    }
    const profiles = await resolveScopeProfiles(
      ctx,
      args.scopeMode,
      args.geographicJurisdictionIds,
    );
    const links = await scopeLinks(ctx, profile._id);
    const previousProfiles = await linkedProfilesForAudit(ctx, links);
    const beforeSnapshot = organizationalJurisdictionSnapshot(
      row,
      profile,
      previousProfiles,
    );
    const now = Date.now();
    const patch = {
      visibility: args.visibility,
      updatedBy: actor.userId,
      updatedAt: now,
    };
    await ctx.db.patch(row._id, patch);
    await ctx.db.patch(profile._id, { scopeMode: args.scopeMode, updatedAt: now });
    for (const link of links) await ctx.db.delete(link._id);
    for (const geographic of profiles) {
      await ctx.db.insert("organizationGeographicScopes", {
        organizationalJurisdictionId: profile._id,
        geographicJurisdictionId: geographic._id,
        createdAt: now,
      });
    }
    await auditJurisdiction(ctx, actor, {
      action: "jurisdiction.organizational_updated",
      targetId: row._id,
      reason,
      before: beforeSnapshot,
      after: organizationalJurisdictionSnapshot(
        { ...row, ...patch },
        { scopeMode: args.scopeMode },
        profiles,
      ),
    });
    return projectClientJurisdiction({ ...row, ...patch });
  },
});

export async function enableJurisdictionForActor(
  ctx: MutationCtx,
  actor: Actor,
  id: Id<"jurisdictions">,
  reason: string,
): Promise<Doc<"jurisdictions">> {
  const row = await ctx.db.get("jurisdictions", id);
  if (!row) throw new ConvexError("JURISDICTION_NOT_FOUND");
  if (row.status !== "draft") throw new ConvexError("INVALID_JURISDICTION_TRANSITION");
  if (
    row.providerSyncState !== "synced" ||
    row.geminiFileSearchStoreName === undefined ||
    !isGeminiFileSearchStoreName(row.geminiFileSearchStoreName)
  ) {
    throw new ConvexError("GEMINI_STORE_NOT_READY");
  }
  if (projectJurisdictionKind(row) === "geographic") {
    const profile = await geographicProfile(ctx, row._id);
    if (row.kind === "geographic" && !profile) {
      throw new ConvexError("GEOGRAPHIC_PROFILE_REQUIRED");
    }
    if (profile) {
      await assertGeographicParent(ctx, row._id, profile.level, profile.parentJurisdictionId);
    }
  } else {
    await assertOrganizationalScope(ctx, row);
  }
  const beforeSnapshot = await completeJurisdictionSnapshot(ctx, row);
  const patch = { status: "enabled" as const, updatedBy: actor.userId, updatedAt: Date.now() };
  await ctx.db.patch(row._id, patch);
  const updated = { ...row, ...patch };
  await auditJurisdiction(ctx, actor, {
    action: "jurisdiction.enabled",
    targetId: row._id,
    reason,
    before: beforeSnapshot,
    after: withUpdatedCommonSnapshot(beforeSnapshot, updated),
  });
  return updated;
}

export const enableJurisdiction = mutation({
  args: { id: v.id("jurisdictions"), reason: v.string() },
  returns: jurisdictionDocumentValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    return projectClientJurisdiction(await enableJurisdictionForActor(ctx, actor, args.id, validateAuditReason(args.reason)));
  },
});

async function assertNoScopeLinks(
  ctx: MutationCtx,
  row: Doc<"jurisdictions">,
  geographic: Doc<"geographicJurisdictions"> | null,
): Promise<void> {
  if (projectJurisdictionKind(row) === "organizational") {
    const profile = await organizationalProfile(ctx, row._id);
    if (!profile) throw new ConvexError("ORGANIZATIONAL_PROFILE_REQUIRED");
    if ((await scopeLinks(ctx, profile._id)).length > 0) {
      throw new ConvexError("JURISDICTION_HAS_ACTIVE_SCOPE_LINKS");
    }
    return;
  }
  if (geographic) {
    const incoming = await ctx.db
      .query("organizationGeographicScopes")
      .withIndex("by_geographicJurisdictionId_and_organizationalJurisdictionId", (q) =>
        q.eq("geographicJurisdictionId", geographic._id),
      )
      .take(1);
    if (incoming.length > 0) throw new ConvexError("JURISDICTION_HAS_ACTIVE_SCOPE_LINKS");
  }
}

export async function archiveJurisdictionForActor(
  ctx: MutationCtx,
  actor: Actor,
  id: Id<"jurisdictions">,
  reason: string,
): Promise<Doc<"jurisdictions">> {
  const row = await ctx.db.get("jurisdictions", id);
  if (!row) throw new ConvexError("JURISDICTION_NOT_FOUND");
  if (row.status === "archived") throw new ConvexError("INVALID_JURISDICTION_TRANSITION");
  const activeResources = await ctx.db
    .query("legalResources")
    .withIndex("by_jurisdictionId_and_status", (q) =>
      q.eq("jurisdictionId", row._id).eq("status", "active"),
    )
    .take(1);
  if (activeResources.length > 0) throw new ConvexError("JURISDICTION_HAS_ACTIVE_RESOURCES");
  let geographic: Doc<"geographicJurisdictions"> | null = null;
  if (projectJurisdictionKind(row) === "geographic") {
    geographic = await geographicProfile(ctx, row._id);
    if (row.kind === "geographic" && !geographic) {
      throw new ConvexError("GEOGRAPHIC_PROFILE_REQUIRED");
    }
  }
  if (geographic) {
    const children = await ctx.db
      .query("geographicJurisdictions")
      .withIndex("by_parentJurisdictionId", (q) => q.eq("parentJurisdictionId", row._id))
      .take(MAX_ARCHIVAL_CHILD_SCAN + 1);
    if (children.length > MAX_ARCHIVAL_CHILD_SCAN) {
      throw new ConvexError("JURISDICTION_HAS_ENABLED_CHILDREN");
    }
    const commonChildren = await Promise.all(
      children.map((child) => ctx.db.get("jurisdictions", child.jurisdictionId)),
    );
    for (const common of commonChildren) {
      if (!common || projectJurisdictionKind(common) !== "geographic") {
        throw new ConvexError("GEOGRAPHIC_CHILD_STATE_INVALID");
      }
      if (common.status === "enabled") {
        throw new ConvexError("JURISDICTION_HAS_ENABLED_CHILDREN");
      }
    }
  }
  await assertNoScopeLinks(ctx, row, geographic);
  const beforeSnapshot = await completeJurisdictionSnapshot(ctx, row);
  const patch = {
    status: "archived" as const,
    isDefault: false,
    updatedBy: actor.userId,
    updatedAt: Date.now(),
  };
  await ctx.db.patch(row._id, patch);
  const archived = { ...row, ...patch };
  await auditJurisdiction(ctx, actor, {
    action: "jurisdiction.archived",
    targetId: row._id,
    reason,
    before: beforeSnapshot,
    after: withUpdatedCommonSnapshot(beforeSnapshot, archived),
  });
  return archived;
}

export const archiveJurisdiction = mutation({
  args: { id: v.id("jurisdictions"), reason: v.string() },
  returns: jurisdictionDocumentValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    return projectClientJurisdiction(await archiveJurisdictionForActor(ctx, actor, args.id, validateAuditReason(args.reason)));
  },
});
