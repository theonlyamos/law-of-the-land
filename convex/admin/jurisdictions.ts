import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import type { AdminRole } from "../lib/adminPermissions";
import { normalizePositiveSafeIntegerBucketId } from "../lib/jurisdictionEligibility";
import {
  MAX_GEOGRAPHIC_DEPTH,
  allowedParentLevelsByLevel,
  geographicLevelValidator,
  jurisdictionDocumentValidator,
  jurisdictionVisibilityValidator,
  normalizeJurisdictionSlug,
  normalizePlaceId,
  organizationScopeModeValidator,
  projectJurisdictionKind,
  type GeographicLevel,
} from "../lib/jurisdictionDomain";
import { verifyVerifiedPlaceClaim } from "../lib/placeClaim";
import { validateAuditReason, writeAudit } from "./audit";
import { requireEnabledAdminPermission } from "./featureFlags";

const MAX_TEXT_LENGTH = 300;
const MAX_SCOPE_LINKS = 8;
const MAX_PROFILE_ROWS = 2;
const MAX_ARCHIVAL_CHILD_SCAN = 100;
const MAX_GEOGRAPHIC_ALIASES = 20;

type Actor = { userId: string; roles: AdminRole[] };

function requiredText(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_TEXT_LENGTH) throw new ConvexError(code);
  return normalized;
}

function optionalBucket(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, "INVALID_BUCKET_ID");
}

function optionalProductionBucket(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizePositiveSafeIntegerBucketId(value);
  if (normalized === null) throw new ConvexError("INVALID_PRODUCTION_BUCKET_ID");
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

function jurisdictionSnapshot(row: Doc<"jurisdictions"> | Omit<Doc<"jurisdictions">, "_id" | "_creationTime">) {
  return {
    code: row.code ?? null,
    name: row.name,
    slug: row.slug,
    status: row.status,
    isDefault: row.isDefault,
    stagingBucketId: row.stagingBucketId ?? null,
    productionBucketId: row.productionBucketId ?? null,
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
    stagingBucketId?: string;
    productionBucketId?: string;
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
    stagingBucketId: optionalBucket(args.stagingBucketId),
    productionBucketId: optionalProductionBucket(args.productionBucketId),
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
    stagingBucketId?: string;
    productionBucketId?: string;
    isDefault: boolean;
  },
  reason: string,
): Promise<Doc<"jurisdictions">> {
  const row = await ctx.db.get("jurisdictions", args.id);
  if (!row || !row.code || !/^[A-Z]{2}$/.test(row.code)) {
    throw new ConvexError("JURISDICTION_NOT_FOUND");
  }
  if (row.status === "archived") throw new ConvexError("JURISDICTION_ARCHIVED");
  const slug = normalizeJurisdictionSlug(args.slug);
  await assertUniqueSlug(ctx, slug, row._id);
  if (args.isDefault) await assertDefaultAvailable(ctx, row._id);
  const productionBucketId = optionalProductionBucket(args.productionBucketId);
  if (row.status === "enabled" && productionBucketId === undefined) {
    throw new ConvexError("PRODUCTION_BUCKET_REQUIRED");
  }
  const patch = {
    name: requiredText(args.name, "INVALID_JURISDICTION_NAME"),
    slug,
    stagingBucketId: optionalBucket(args.stagingBucketId),
    productionBucketId,
    isDefault: args.isDefault,
    providerSyncState: "pending" as const,
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

const bucketArgs = {
  stagingBucketId: v.optional(v.string()),
  productionBucketId: v.optional(v.string()),
} as const;

const geographicMutationArgs = {
  verifiedPlaceClaim: v.string(),
  level: geographicLevelValidator,
  parentJurisdictionId: v.optional(v.id("jurisdictions")),
  ...bucketArgs,
  reason: v.string(),
} as const;

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
      stagingBucketId: optionalBucket(args.stagingBucketId),
      productionBucketId: optionalProductionBucket(args.productionBucketId),
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
      stagingBucketId: optionalBucket(args.stagingBucketId),
      productionBucketId: optionalProductionBucket(args.productionBucketId),
      providerSyncState: "pending" as const,
      legacyCountryCode: args.level === "country" ? place.countryCode : undefined,
      updatedBy: actor.userId,
      updatedAt: now,
    };
    if (row.status === "enabled" && !patch.productionBucketId) {
      throw new ConvexError("PRODUCTION_BUCKET_REQUIRED");
    }
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
    return { ...row, ...patch };
  },
});

const organizationalMutationArgs = {
  visibility: jurisdictionVisibilityValidator,
  scopeMode: organizationScopeModeValidator,
  geographicJurisdictionIds: v.array(v.id("jurisdictions")),
  ...bucketArgs,
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
      stagingBucketId: optionalBucket(args.stagingBucketId),
      productionBucketId: optionalProductionBucket(args.productionBucketId),
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
    const productionBucketId = optionalProductionBucket(args.productionBucketId);
    if (row.status === "enabled" && !productionBucketId) {
      throw new ConvexError("PRODUCTION_BUCKET_REQUIRED");
    }
    const now = Date.now();
    const patch = {
      visibility: args.visibility,
      stagingBucketId: optionalBucket(args.stagingBucketId),
      productionBucketId,
      providerSyncState: "pending" as const,
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
    return { ...row, ...patch };
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
  if (!row.productionBucketId) throw new ConvexError("PRODUCTION_BUCKET_REQUIRED");
  if (normalizePositiveSafeIntegerBucketId(row.productionBucketId) === null) {
    throw new ConvexError("INVALID_PRODUCTION_BUCKET_ID");
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
    return await enableJurisdictionForActor(ctx, actor, args.id, validateAuditReason(args.reason));
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
    return await archiveJurisdictionForActor(ctx, actor, args.id, validateAuditReason(args.reason));
  },
});
