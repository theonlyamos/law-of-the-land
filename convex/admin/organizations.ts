import { archiveOrganizationForActor, updateOrganizationPresentation } from "../organizations";
import { assertOwnerCapacity, organizationName as normalizeName, organizationWebsite as normalizeWebsite } from "../lib/organizationManagement";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx } from "../_generated/server";
import {
  MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS,
  organizationClassValidator,
  organizationMembershipStatusValidator,
} from "../lib/jurisdictionDomain";
import { activeOrganizationIdsForUser } from "../lib/jurisdictionAccess";
import { authComponent } from "../auth";
import { organizationRoleValidator } from "../lib/widgetContracts";
import {
  requireEnabledAdminCatalogRead,
  requireEnabledAdminPermission,
} from "./featureFlags";
import { validateAuditReason, writeAudit } from "./audit";

const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_CATALOG_PAGE_SIZE = 20;
const MAX_CATALOG_SEARCH_LENGTH = 100;

const organizationStatusValidator = v.union(
  v.literal("active"),
  v.literal("archived"),
);
const organizationDocValidator = v.object({
  _id: v.id("organizations"),
  _creationTime: v.number(),
  name: v.string(),
  slug: v.string(),
  class: organizationClassValidator,
  website: v.optional(v.string()),
  status: organizationStatusValidator,
  ownerUserId: v.optional(v.string()),
  createdBy: v.string(),
  updatedBy: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
});
const membershipDocValidator = v.object({
  role: v.optional(organizationRoleValidator),
  _id: v.id("organizationMemberships"),
  _creationTime: v.number(),
  organizationId: v.id("organizations"),
  userId: v.string(),
  status: organizationMembershipStatusValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
});
const organizationOptionValidator = v.object({
  id: v.id("organizations"),
  name: v.string(),
  slug: v.string(),
  class: organizationClassValidator,
});

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

function normalizeSlug(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!ORGANIZATION_SLUG_PATTERN.test(normalized) || normalized.length > 80) {
    throw new ConvexError("INVALID_ORGANIZATION_SLUG");
  }
  return normalized;
}

async function assertUniqueOrganizationSlug(
  ctx: MutationCtx,
  slug: string,
  exceptId?: Id<"organizations">,
): Promise<void> {
  const rows = await ctx.db
    .query("organizations")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .take(2);
  if (rows.some((row) => row._id !== exceptId)) {
    throw new ConvexError("ORGANIZATION_SLUG_EXISTS");
  }
}

async function auditOrganizationChange(
  ctx: MutationCtx,
  actor: { userId: string; roles: string[] },
  input: {
    action: string;
    targetType: "organization" | "organizationMembership";
    targetId: string;
    reason: string;
    before?: string;
    after?: string;
  },
) {
  await writeAudit(ctx, {
    actorId: actor.userId,
    actorRoles: actor.roles,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason,
    beforeSummary: input.before,
    afterSummary: input.after,
    correlationId: `op_${crypto.randomUUID().replaceAll("-", "")}`,
    outcome: "success",
  });
}

export const listActiveOrganizationOptions = query({
  args: {
    query: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(organizationOptionValidator),
  handler: async (ctx, args) => {
    await requireEnabledAdminCatalogRead(ctx, "organization");
    validateCatalogPageSize(args.paginationOpts.numItems);
    const search = normalizeCatalogSearch(args.query);
    const result = search === undefined
      ? await ctx.db
          .query("organizations")
          .withIndex("by_status_and_name", (q) => q.eq("status", "active"))
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("organizations")
          .withSearchIndex("search_name", (q) =>
            q.search("name", search).eq("status", "active"),
          )
          .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((row) => ({
        id: row._id,
        name: row.name,
        slug: row.slug,
        class: row.class,
      })),
    };
  },
});

export const createOrganization = mutation({
  args: {
    name: v.string(),
    slug: v.string(),
    class: organizationClassValidator,
    website: v.optional(v.string()),
    reason: v.string(),
  },
  returns: v.id("organizations"),
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "organization", "write");
    const reason = validateAuditReason(args.reason);
    const name = normalizeName(args.name);
    const slug = normalizeSlug(args.slug);
    const website = normalizeWebsite(args.website);
    await assertUniqueOrganizationSlug(ctx, slug);
    const now = Date.now();
    const id = await ctx.db.insert("organizations", {
      name,
      slug,
      class: args.class,
      website,
      status: "active",
      createdBy: actor.userId,
      updatedBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    });
    await auditOrganizationChange(ctx, actor, {
      action: "organization.created",
      targetType: "organization",
      targetId: id,
      reason,
      after: JSON.stringify({ name, slug, class: args.class, status: "active" }),
    });
    return id;
  },
});

export const updateOrganization = mutation({
  args: {
    id: v.id("organizations"),
    name: v.string(),
    slug: v.string(),
    class: organizationClassValidator,
    website: v.optional(v.string()),
    reason: v.string(),
  },
  returns: organizationDocValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "organization", "write");
    const reason = validateAuditReason(args.reason);
    const organization = await ctx.db.get("organizations", args.id);
    if (!organization) throw new ConvexError("ORGANIZATION_NOT_FOUND");
    if (organization.status !== "active") throw new ConvexError("ORGANIZATION_ARCHIVED");
    const name = normalizeName(args.name);
    const slug = normalizeSlug(args.slug);
    const website = normalizeWebsite(args.website);
    await assertUniqueOrganizationSlug(ctx, slug, organization._id);
    const now = Date.now();
    const patch = {
      name,
      slug,
      class: args.class,
      website,
      updatedBy: actor.userId,
      updatedAt: now,
    };
    await updateOrganizationPresentation(ctx, organization._id, { name, class: args.class, website }, actor.userId);
    await ctx.db.patch(organization._id, { slug });
    await auditOrganizationChange(ctx, actor, {
      action: "organization.updated",
      targetType: "organization",
      targetId: organization._id,
      reason,
      before: JSON.stringify({
        name: organization.name,
        slug: organization.slug,
        class: organization.class,
        status: organization.status,
      }),
      after: JSON.stringify({ name, slug, class: args.class, status: organization.status }),
    });
    return { ...organization, ...patch };
  },
});

export const archiveOrganization = mutation({
  args: { id: v.id("organizations"), reason: v.string() },
  returns: organizationDocValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "organization", "write");
    const reason = validateAuditReason(args.reason);
    const organization = await ctx.db.get("organizations", args.id);
    if (!organization) throw new ConvexError("ORGANIZATION_NOT_FOUND");
    if (organization.status !== "active") throw new ConvexError("INVALID_ORGANIZATION_TRANSITION");
    const patch = { status: "archived" as const, updatedBy: actor.userId, updatedAt: Date.now() };
    await archiveOrganizationForActor(ctx, organization, actor.userId);
    await auditOrganizationChange(ctx, actor, {
      action: "organization.archived",
      targetType: "organization",
      targetId: organization._id,
      reason,
      before: JSON.stringify({ status: organization.status }),
      after: JSON.stringify({ status: patch.status }),
    });
    return { ...organization, ...patch };
  },
});

export const setOrganizationMemberStatus = mutation({
  args: {
    organizationId: v.id("organizations"),
    userId: v.string(),
    status: organizationMembershipStatusValidator,
    reason: v.string(),
  },
  returns: membershipDocValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "organization", "write");
    const reason = validateAuditReason(args.reason);
    const [organization, targetUser, memberships] = await Promise.all([
      ctx.db.get("organizations", args.organizationId),
      authComponent.getAnyUserById(ctx, args.userId),
      ctx.db
        .query("organizationMemberships")
        .withIndex("by_organizationId_and_userId", (q) =>
          q.eq("organizationId", args.organizationId).eq("userId", args.userId),
        )
        .take(2),
    ]);
    if (!organization) throw new ConvexError("ORGANIZATION_NOT_FOUND");
    if (!targetUser) throw new ConvexError("ORGANIZATION_MEMBER_NOT_FOUND");
    if (memberships.length > 1) throw new ConvexError("ORGANIZATION_MEMBERSHIP_STATE_INVALID");
    const current = memberships[0];
    if (organization.ownerUserId === args.userId && args.status !== "active") throw new ConvexError("ORGANIZATION_OWNER_TRANSFER_REQUIRED");
    if (args.status === "active") {
      if (organization.status !== "active") throw new ConvexError("ORGANIZATION_ARCHIVED");
      if (current?.status !== "active") {
        const activeOrganizationIds = await activeOrganizationIdsForUser(ctx, args.userId);
        if (activeOrganizationIds.size >= MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS) {
          throw new ConvexError("ORGANIZATION_MEMBERSHIP_LIMIT");
        }
      }
    }
    const now = Date.now();
    let createdMembershipId: Id<"organizationMemberships"> | undefined;
    if (current) await ctx.db.patch(current._id, { status: args.status, updatedAt: now });
    else {
      createdMembershipId = await ctx.db.insert("organizationMemberships", {
        organizationId: args.organizationId,
        userId: args.userId,
        status: args.status,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (current?.status !== args.status || !current) {
      await auditOrganizationChange(ctx, actor, {
        action: "organization.member_status_set",
        targetType: "organizationMembership",
        targetId: `${args.organizationId}:${args.userId}`,
        reason,
        before: JSON.stringify({ status: current?.status ?? null }),
        after: JSON.stringify({ status: args.status }),
      });
    }
    if (current) return { ...current, status: args.status, updatedAt: now };
    const created = await ctx.db.get("organizationMemberships", createdMembershipId!);
    if (!created) throw new ConvexError("ORGANIZATION_MEMBERSHIP_STATE_INVALID");
    return created;
  },
});

export const setOrganizationMemberRole = mutation({
  args: { organizationId: v.id("organizations"), memberUserId: v.string(), role: organizationRoleValidator, reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "organization", "write");
    const reason = validateAuditReason(args.reason);
    const organization = await ctx.db.get(args.organizationId);
    const user = await authComponent.getAnyUserById(ctx, args.memberUserId);
    const membership = await ctx.db.query("organizationMemberships").withIndex("by_organizationId_and_userId", q => q.eq("organizationId", args.organizationId).eq("userId", args.memberUserId)).unique();
    if (!organization || organization.status !== "active" || !user || !membership || membership.status !== "active") throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
    if (organization.ownerUserId === args.memberUserId && args.role !== "manager") throw new ConvexError("ORGANIZATION_OWNER_TRANSFER_REQUIRED");
    await ctx.db.patch(membership._id, { role: args.role, updatedAt: Date.now() });
    await auditOrganizationChange(ctx, actor, { action: "organization.member_role_set", targetType: "organizationMembership", targetId: membership._id, reason, before: membership.role ?? "member", after: args.role });
    return null;
  },
});

export const assignInitialOwner = mutation({ args: { organizationId: v.id("organizations"), memberUserId: v.string(), reason: v.string() }, returns: v.null(), handler: async (ctx, args) => {
  const actor = await requireEnabledAdminPermission(ctx, "organization", "write"), reason = validateAuditReason(args.reason);
  const organization = await ctx.db.get(args.organizationId);
  const member = await ctx.db.query("organizationMemberships").withIndex("by_organizationId_and_userId", q => q.eq("organizationId", args.organizationId).eq("userId", args.memberUserId)).unique();
  const account = await authComponent.getAnyUserById(ctx, args.memberUserId);
  if (!organization || organization.status !== "active" || organization.ownerUserId || member?.status !== "active" || member.role !== "manager" || !account || account.banned || !account.emailVerified) throw new ConvexError("ORGANIZATION_OWNER_ASSIGNMENT_INVALID");
  await assertOwnerCapacity(ctx, args.memberUserId);
  await ctx.db.patch(organization._id, { ownerUserId: args.memberUserId, updatedBy: actor.userId, updatedAt: Date.now() });
  await auditOrganizationChange(ctx, actor, { action: "organization.owner_assigned", targetType: "organization", targetId: organization._id, reason, after: args.memberUserId });
  return null;
} });
