import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { assertJurisdictionAccess } from "./jurisdictionAccess";
import {
  allowedParentLevelsByLevel,
  MAX_GEOGRAPHIC_DEPTH,
  normalizeGeographicAlias,
  type ResearchScope,
  type ResearchScopeItem,
} from "./jurisdictionDomain";

const MAX_GEOGRAPHIC_HINTS = 3;
const MAX_HINT_LENGTH = 200;
const MAX_ALIAS_MATCHES = 10;
const MAX_SCOPE_LINKS = 8;

type GeographicNode = {
  common: Doc<"jurisdictions">;
  profile: Doc<"geographicJurisdictions">;
};

type OrganizationScope = {
  profile: Doc<"organizationalJurisdictions">;
  linkedProfileIds: Set<Id<"geographicJurisdictions">>;
};

function accessDenied(): never {
  throw new ConvexError("JURISDICTION_ACCESS_DENIED");
}

function invalidScope(): never {
  throw new ConvexError("JURISDICTION_SCOPE_STATE_INVALID");
}

async function geographicNode(
  ctx: QueryCtx,
  jurisdictionId: Id<"jurisdictions">,
): Promise<GeographicNode | null> {
  const [common, geographicProfiles, organizationalProfiles] = await Promise.all([
    ctx.db.get("jurisdictions", jurisdictionId),
    ctx.db
      .query("geographicJurisdictions")
      .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", jurisdictionId))
      .take(2),
    ctx.db
      .query("organizationalJurisdictions")
      .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", jurisdictionId))
      .take(1),
  ]);
  if (
    !common ||
    common.status !== "enabled" ||
    common.kind !== "geographic" ||
    common.visibility !== "public" ||
    common.organizationId !== undefined ||
    geographicProfiles.length !== 1 ||
    organizationalProfiles.length !== 0
  ) {
    return null;
  }
  return { common, profile: geographicProfiles[0] };
}

async function selectedGeographicNode(
  ctx: QueryCtx,
  selected: Doc<"jurisdictions">,
): Promise<GeographicNode> {
  const node = await geographicNode(ctx, selected._id);
  if (!node) invalidScope();
  return node;
}

async function organizationScope(
  ctx: QueryCtx,
  selected: Doc<"jurisdictions">,
): Promise<OrganizationScope> {
  if (
    selected.kind !== "organizational" ||
    (selected.visibility !== "public" && selected.visibility !== "members") ||
    !selected.organizationId
  ) {
    invalidScope();
  }
  const [organization, profiles, oppositeProfiles] = await Promise.all([
    ctx.db.get("organizations", selected.organizationId),
    ctx.db
      .query("organizationalJurisdictions")
      .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", selected._id))
      .take(2),
    ctx.db
      .query("geographicJurisdictions")
      .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", selected._id))
      .take(1),
  ]);
  if (
    !organization ||
    organization.status !== "active" ||
    profiles.length !== 1 ||
    oppositeProfiles.length !== 0
  ) {
    invalidScope();
  }
  const profile = profiles[0];
  const links = await ctx.db
    .query("organizationGeographicScopes")
    .withIndex("by_organizationalJurisdictionId_and_geographicJurisdictionId", (q) =>
      q.eq("organizationalJurisdictionId", profile._id),
    )
    .take(MAX_SCOPE_LINKS + 1);
  if (
    links.length > MAX_SCOPE_LINKS ||
    (profile.scopeMode === "global" && links.length !== 0) ||
    (profile.scopeMode === "linked_geographies" && links.length === 0)
  ) {
    invalidScope();
  }
  const linkedProfileIds = new Set(links.map((link) => link.geographicJurisdictionId));
  if (linkedProfileIds.size !== links.length) invalidScope();
  const linkedNodes = await Promise.all(
    links.map(async (link) => {
      const geographicProfile = await ctx.db.get(
        "geographicJurisdictions",
        link.geographicJurisdictionId,
      );
      if (!geographicProfile) return null;
      return await geographicNode(ctx, geographicProfile.jurisdictionId);
    }),
  );
  if (linkedNodes.some((node) => node === null)) invalidScope();
  return { profile, linkedProfileIds };
}

function scopeItem(
  node: GeographicNode,
  relation: "selected" | "geographic_ancestor" | "organizational_geography",
): ResearchScopeItem {
  return {
    jurisdictionId: node.common._id,
    name: node.common.name,
    kind: "geographic",
    relation,
  };
}

async function appendAncestors(
  ctx: QueryCtx,
  start: GeographicNode,
  items: ResearchScopeItem[],
  seen: Set<Id<"jurisdictions">>,
  geographicBudget: number,
): Promise<void> {
  let current = start;
  const branchVisited = new Set<Id<"jurisdictions">>([start.common._id]);
  while (items.filter((item) => item.kind === "geographic").length < geographicBudget) {
    const parentId = current.profile.parentJurisdictionId;
    if (!parentId || branchVisited.has(parentId)) return;
    branchVisited.add(parentId);
    const parent = await geographicNode(ctx, parentId);
    if (
      !parent ||
      !allowedParentLevelsByLevel[current.profile.level].includes(parent.profile.level)
    ) {
      return;
    }
    if (!seen.has(parent.common._id)) {
      items.push(scopeItem(parent, "geographic_ancestor"));
      seen.add(parent.common._id);
    }
    current = parent;
  }
}

function canonicalHints(values: string[]): string[] {
  if (values.length > MAX_GEOGRAPHIC_HINTS) {
    throw new ConvexError("INVALID_GEOGRAPHIC_HINTS");
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeGeographicAlias(value);
    if (!normalized || normalized.length > MAX_HINT_LENGTH || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

async function resolveHint(
  ctx: QueryCtx,
  normalizedHint: string,
  organization: OrganizationScope,
): Promise<GeographicNode | null> {
  const aliases = await ctx.db
    .query("geographicJurisdictionAliases")
    .withIndex("by_normalizedAlias", (q) => q.eq("normalizedAlias", normalizedHint))
    .take(MAX_ALIAS_MATCHES + 1);
  if (aliases.length === 0 || aliases.length > MAX_ALIAS_MATCHES) return null;
  const candidates = await Promise.all(
    aliases.map(async (alias) => {
      const node = await geographicNode(ctx, alias.jurisdictionId);
      if (!node) return null;
      if (organization.profile.scopeMode === "global") return node;
      const links = await ctx.db
        .query("organizationGeographicScopes")
        .withIndex("by_organizationalJurisdictionId_and_geographicJurisdictionId", (q) =>
          q
            .eq("organizationalJurisdictionId", organization.profile._id)
            .eq("geographicJurisdictionId", node.profile._id),
        )
        .take(2);
      return links.length === 1 && organization.linkedProfileIds.has(node.profile._id)
        ? node
        : undefined;
    }),
  );
  if (candidates.some((candidate) => candidate === null)) return null;
  const eligible = new Map<Id<"jurisdictions">, GeographicNode>();
  for (const candidate of candidates) {
    if (candidate) eligible.set(candidate.common._id, candidate);
  }
  return eligible.size === 1 ? [...eligible.values()][0] : null;
}

export async function resolveResearchScopeForJurisdiction(
  ctx: QueryCtx,
  jurisdictionId: Id<"jurisdictions">,
  geographicHints: string[],
): Promise<ResearchScope> {
  const selected = await ctx.db.get("jurisdictions", jurisdictionId);
  if (!selected) accessDenied();
  await assertJurisdictionAccess(ctx, selected);
  if (geographicHints.length > MAX_GEOGRAPHIC_HINTS) {
    throw new ConvexError("INVALID_GEOGRAPHIC_HINTS");
  }

  if (selected.kind === "geographic") {
    const node = await selectedGeographicNode(ctx, selected);
    const items = [scopeItem(node, "selected")];
    await appendAncestors(
      ctx,
      node,
      items,
      new Set([selected._id]),
      MAX_GEOGRAPHIC_DEPTH,
    );
    return { selectedJurisdictionId: selected._id, items };
  }

  const organization = await organizationScope(ctx, selected);
  const items: ResearchScopeItem[] = [{
    jurisdictionId: selected._id,
    name: selected.name,
    kind: "organizational",
    relation: "selected",
  }];
  const seen = new Set<Id<"jurisdictions">>([selected._id]);
  for (const hint of canonicalHints(geographicHints)) {
    if (items.length >= MAX_GEOGRAPHIC_DEPTH + 1) break;
    const anchor = await resolveHint(ctx, hint, organization);
    if (!anchor || seen.has(anchor.common._id)) continue;
    items.push(scopeItem(anchor, "organizational_geography"));
    seen.add(anchor.common._id);
    await appendAncestors(
      ctx,
      anchor,
      items,
      seen,
      MAX_GEOGRAPHIC_DEPTH,
    );
  }
  return { selectedJurisdictionId: selected._id, items };
}
