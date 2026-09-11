import { requireAssuredSession } from "./lib/requireAdmin";
import { v, ConvexError } from "convex/values";
import { query, mutation } from "./_generated/server";
import {
  requireOrganizationAccess,
  requireOrganizationOwner,
  organizationAccessForUser,
} from "./lib/organizationAccess";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  organizationClassValidator,
  MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS,
} from "./lib/jurisdictionDomain";
import {
  assertMembershipCapacity,
  assertOwnerCapacity,
  currentOrganizationJurisdictions,
  discoveryText,
  finishOrganizationOperation,
  organizationName,
  organizationOperation,
  organizationRate,
  organizationWebsite,
  singleOrganizationJurisdiction,
  uniqueOrganizationSlug,
  validatePageSize,
  verifiedOrganizationUser,
} from "./lib/organizationManagement";
import {
  bumpContentRevision,
  bumpWidgetAccessVersion,
} from "./lib/widgetAuthority";
import { consumeStepUp } from "./admin/publication";
import { writeAudit, validateAuditReason } from "./admin/audit";

export const setVisibility = mutation({
  args: {
    organizationId: v.id("organizations"),
    visibility: v.union(v.literal("public"), v.literal("members")),
    confirmation: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireOrganizationAccess(
      ctx,
      args.organizationId,
      "manage",
    );
    const jurisdiction = await singleOrganizationJurisdiction(
      ctx,
      args.organizationId,
    );
    if (
      !jurisdiction ||
      jurisdiction.kind !== "organizational" ||
      jurisdiction.status === "archived"
    )
      throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
    if (
      args.confirmation !==
      `${args.visibility === "public" ? "PUBLIC" : "PRIVATE"} ${jurisdiction._id}`
    )
      throw new ConvexError("ADMIN_CONFIRMATION_MISMATCH");
    await consumeStepUp(
      ctx,
      actor.userId,
      actor.sessionId,
      "organization_visibility",
      jurisdiction._id,
      args.idempotencyKey,
    );
    if (jurisdiction.visibility === args.visibility) return null;
    await ctx.db.patch(jurisdiction._id, {
      visibility: args.visibility,
      updatedAt: Date.now(),
      updatedBy: actor.userId,
    });
    await bumpWidgetAccessVersion(ctx, jurisdiction._id);
    await bumpContentRevision(ctx, jurisdiction._id);
    await writeAudit(ctx, {
      actorId: actor.userId,
      actorRoles: [],
      organizationId: actor.organizationId,
      organizationRole: actor.organizationRole,
      action: "organization.visibility_set",
      targetType: "jurisdiction",
      targetId: jurisdiction._id,
      beforeSummary: jurisdiction.visibility,
      afterSummary: args.visibility,
      outcome: "success",
    });
    return null;
  },
});

export const getWorkspace = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    const actor = await requireOrganizationAccess(ctx, organizationId, "read");
    const organization = await ctx.db.get(organizationId);
    const rows = await currentOrganizationJurisdictions(ctx, organizationId);
    const jurisdiction = rows.length === 1 ? rows[0] : null;
    const resource = jurisdiction
      ? await ctx.db
          .query("legalResources")
          .withIndex("by_jurisdictionId_and_activeVersionId", (q) =>
            q
              .eq("jurisdictionId", jurisdiction._id)
              .gt("activeVersionId", undefined),
          )
          .first()
      : null;
    const version = resource?.activeVersionId
      ? await ctx.db.get(resource.activeVersionId)
      : null;
    return {
      organization: { id: organizationId, name: organization!.name },
      role: actor.organizationRole,
      hasPublishedDocuments:
        resource?.status === "active" &&
        version?.status === "published" &&
        version.resourceId === resource._id,
      jurisdiction: jurisdiction
        ? {
            id: jurisdiction._id,
            name: jurisdiction.name,
            visibility: jurisdiction.visibility,
            status: jurisdiction.status,
          }
        : null,
      canManage: actor.canManage,
      canReview: actor.canReview,
    };
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const session = await requireAssuredSession(ctx);
    const memberships = await ctx.db
      .query("organizationMemberships")
      .withIndex("by_userId_and_status", (q) =>
        q.eq("userId", session.userId).eq("status", "active"),
      )
      .take(MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS + 1);
    if (memberships.length > MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS)
      throw new ConvexError("ORGANIZATION_MEMBERSHIP_LIMIT");
    return (
      await Promise.all(
        memberships.map(async (member) => {
          const organization = await ctx.db.get(member.organizationId);
          return organization?.status === "active"
            ? {
                id: organization._id,
                name: organization.name,
                role: member.role ?? "member",
              }
            : null;
        }),
      )
    ).filter((row) => row !== null);
  },
});

export const setPresentation = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireOrganizationAccess(
      ctx,
      args.organizationId,
      "manage",
    );
    const jurisdiction = await singleOrganizationJurisdiction(
      ctx,
      args.organizationId,
    );
    if (
      jurisdiction?.kind !== "organizational" ||
      jurisdiction.status === "archived"
    )
      throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
    const name = args.name.trim().replace(/\s+/g, " "),
      reason = validateAuditReason(args.reason);
    if (!name || name.length > 300)
      throw new ConvexError("INVALID_JURISDICTION_NAME");
    if (name === jurisdiction.name) return null;
    const organization = await ctx.db.get(args.organizationId);
    await ctx.db.patch(jurisdiction._id, {
      name,
      discoveryText: discoveryText(organization!.name, name),
      updatedAt: Date.now(),
      updatedBy: actor.userId,
    });
    await bumpContentRevision(ctx, jurisdiction._id);
    await writeAudit(ctx, {
      actorId: actor.userId,
      actorRoles: [],
      organizationId: actor.organizationId,
      organizationRole: actor.organizationRole,
      action: "organization.presentation_updated",
      targetType: "jurisdiction",
      targetId: jurisdiction._id,
      reason,
      outcome: "success",
    });
    return null;
  },
});

function summary(
  row: Doc<"organizations">,
  role: "member" | "manager" | "reviewer",
  userId: string,
) {
  return {
    id: row._id,
    name: row.name,
    class: row.class,
    website: row.website,
    status: row.status,
    role,
    isOwner: row.ownerUserId === userId,
    needsOwner: !row.ownerUserId,
  };
}
export const createOrganization = mutation({
  args: {
    name: v.string(),
    class: organizationClassValidator,
    website: v.optional(v.string()),
    idempotencyKey: v.string(),
  },
  returns: v.id("organizations"),
  handler: async (ctx, args) => {
    const actor = await verifiedOrganizationUser(ctx);
    const name = organizationName(args.name),
      website = organizationWebsite(args.website);
    const action = "organization.create";
    const operation = await organizationOperation(
      ctx,
      actor.userId,
      action,
      args.idempotencyKey,
      { name, class: args.class, website: website ?? null },
    );
    if (operation.old) return operation.old.targetId as Id<"organizations">;
    await assertOwnerCapacity(ctx, actor.userId);
    await assertMembershipCapacity(ctx, actor.userId);
    await organizationRate(ctx, "organization_create", actor.userId, 5);
    const now = Date.now();
    const id = await ctx.db.insert("organizations", {
      name,
      slug: await uniqueOrganizationSlug(ctx, "organizations", name),
      class: args.class,
      website,
      ownerUserId: actor.userId,
      status: "active",
      createdBy: actor.userId,
      updatedBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("organizationMemberships", {
      organizationId: id,
      userId: actor.userId,
      role: "manager",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await finishOrganizationOperation(
      ctx,
      actor.userId,
      action,
      args.idempotencyKey,
      operation.fingerprint,
      id,
    );
    await writeAudit(ctx, {
      actorId: actor.userId,
      actorRoles: [],
      organizationId: id,
      organizationRole: "manager",
      action: "organization.created",
      targetType: "organization",
      targetId: id,
      outcome: "success",
    });
    return id;
  },
});
export const listMyOrganizations = query({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.union(v.literal("active"), v.literal("archived")),
  },
  handler: async (ctx, args) => {
    const actor = await requireAssuredSession(ctx);
    validatePageSize(args.paginationOpts.numItems);
    if (args.status === "archived") {
      const result = await ctx.db
        .query("organizations")
        .withIndex("by_ownerUserId_and_status", (q) =>
          q.eq("ownerUserId", actor.userId).eq("status", "archived"),
        )
        .paginate(args.paginationOpts);
      return {
        ...result,
        page: result.page.map((row) => summary(row, "manager", actor.userId)),
      };
    }
    const result = await ctx.db
      .query("organizationMemberships")
      .withIndex("by_userId_and_status", (q) =>
        q.eq("userId", actor.userId).eq("status", "active"),
      )
      .paginate(args.paginationOpts);
    const page = await Promise.all(
      result.page.map(async (member) => {
        const organization = await ctx.db.get(member.organizationId);
        return organization?.status === "active"
          ? summary(organization, member.role ?? "member", actor.userId)
          : null;
      }),
    );
    return { ...result, page: page.filter((row) => row !== null) };
  },
});
export const getOrganizationWorkspace = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, args) => {
    const session = await requireAssuredSession(ctx);
    const access = await organizationAccessForUser(
      ctx,
      args.organizationId,
      session.userId,
    );
    if (!access.canRead) {
      const owner = await requireOrganizationOwner(
        ctx,
        args.organizationId,
        true,
      );
      return {
        organization: summary(owner.organization, "manager", owner.userId),
        canManage: false,
        canReview: false,
        canManageMembers: false,
      };
    }
    return {
      organization: summary(
        access.organization!,
        access.membership?.role ?? "member",
        session.userId,
      ),
      canManage: access.canManage && !session.impersonatedBy,
      canReview: access.canReview && !session.impersonatedBy,
      canManageMembers: access.canManageMembers && !session.impersonatedBy,
    };
  },
});
export async function updateOrganizationPresentation(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  input: {
    name: string;
    class: Doc<"organizations">["class"];
    website?: string;
  },
  userId: string,
) {
  const name = organizationName(input.name),
    website = organizationWebsite(input.website);
  const rows = await currentOrganizationJurisdictions(ctx, organizationId);
  await ctx.db.patch(organizationId, {
    name,
    class: input.class,
    website,
    updatedBy: userId,
    updatedAt: Date.now(),
  });
  for (const row of rows)
    await ctx.db.patch(row._id, {
      discoveryText: discoveryText(name, row.name),
    });
}
export const updateOrganization = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    class: organizationClassValidator,
    website: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireOrganizationOwner(ctx, args.organizationId);
    await updateOrganizationPresentation(
      ctx,
      args.organizationId,
      args,
      actor.userId,
    );
    await writeAudit(ctx, {
      actorId: actor.userId,
      actorRoles: [],
      organizationId: args.organizationId,
      organizationRole: "manager",
      action: "organization.updated",
      targetType: "organization",
      targetId: args.organizationId,
      outcome: "success",
    });
    return null;
  },
});
export async function archiveOrganizationForActor(
  ctx: MutationCtx,
  organization: Doc<"organizations">,
  userId: string,
) {
  const rows = await currentOrganizationJurisdictions(ctx, organization._id);
  const invitations = await ctx.db
    .query("organizationInvitations")
    .withIndex("by_organizationId_and_state_and_expiresAt", (q) =>
      q
        .eq("organizationId", organization._id)
        .eq("state", "pending")
        .gt("expiresAt", Date.now()),
    )
    .take(21);
  if (invitations.length > 20)
    throw new ConvexError("ORGANIZATION_INVITATION_LIMIT");
  for (const row of rows) {
    const widget = await ctx.db
      .query("jurisdictionWidgets")
      .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", row._id))
      .unique();
    if (widget)
      await ctx.db.patch(widget._id, {
        enabled: false,
        accessVersion: widget.accessVersion + 1,
        updatedAt: Date.now(),
        updatedBy: userId,
      });
    await bumpContentRevision(ctx, row._id);
  }
  for (const invitation of invitations)
    await ctx.db.patch(invitation._id, {
      state: "revoked",
      updatedAt: Date.now(),
    });
  await ctx.db.patch(organization._id, {
    status: "archived",
    updatedAt: Date.now(),
    updatedBy: userId,
  });
}
const lifecycleArgs = {
  reason: v.string(),
  organizationId: v.id("organizations"),
  confirmation: v.string(),
  idempotencyKey: v.string(),
};
async function organizationLifecycle(
  ctx: MutationCtx,
  args: {
    reason: string;
    organizationId: Id<"organizations">;
    confirmation: string;
    idempotencyKey: string;
  },
  restore: boolean,
) {
  const session = await verifiedOrganizationUser(ctx);
  const action = restore ? "organization_restore" : "organization_archive";
  const reason = validateAuditReason(args.reason);
  const operation = await organizationOperation(
    ctx,
    session.userId,
    action,
    args.idempotencyKey,
    { organizationId: args.organizationId, confirmation: args.confirmation, reason },
  );
  if (operation.old) return null;
  const actor = await requireOrganizationOwner(
    ctx,
    args.organizationId,
    restore,
  );
  if (
    args.confirmation !==
    `${restore ? "RESTORE" : "ARCHIVE"} ${args.organizationId}`
  )
    throw new ConvexError("ADMIN_CONFIRMATION_MISMATCH");
  if (actor.organization.status !== (restore ? "archived" : "active"))
    throw new ConvexError("INVALID_ORGANIZATION_TRANSITION");
  await consumeStepUp(
    ctx,
    actor.userId,
    actor.sessionId,
    action,
    args.organizationId,
    args.idempotencyKey,
  );
  if (restore) {
    await assertOwnerCapacity(ctx, actor.userId);
    await ctx.db.patch(args.organizationId, {
      status: "active",
      updatedAt: Date.now(),
      updatedBy: actor.userId,
    });
  } else
    await archiveOrganizationForActor(ctx, actor.organization, actor.userId);
  await finishOrganizationOperation(
    ctx,
    actor.userId,
    action,
    args.idempotencyKey,
    operation.fingerprint,
    args.organizationId,
  );
  await writeAudit(ctx, {
    actorId: actor.userId,
    actorRoles: [],
    organizationId: args.organizationId,
    organizationRole: "manager",
    action: restore ? "organization.restored" : "organization.archived",
    reason,
    targetType: "organization",
    targetId: args.organizationId,
    outcome: "success",
  });
  return null;
}
export const archive = mutation({
  args: lifecycleArgs,
  returns: v.null(),
  handler: (ctx, args) => organizationLifecycle(ctx, args, false),
});
export const restore = mutation({
  args: lifecycleArgs,
  returns: v.null(),
  handler: (ctx, args) => organizationLifecycle(ctx, args, true),
});
