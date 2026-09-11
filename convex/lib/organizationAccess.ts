import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { requireAssuredSession } from "./requireAdmin";

type Ctx = QueryCtx | MutationCtx;
export type OrganizationPermission = "read" | "manage" | "review";
export function organizationCapabilities(
  organization: Doc<"organizations"> | null,
  membership: Doc<"organizationMemberships"> | null,
  userId: string,
) {
  const valid =
    !!organization &&
    organization.status === "active" &&
    membership?.status === "active" &&
    membership.organizationId === organization._id &&
    membership.userId === userId &&
    (organization.ownerUserId !== userId || membership.role === "manager");
  const isOwner = valid && organization.ownerUserId === userId;
  return {
    isOwner,
    canManage: valid && membership.role === "manager",
    canReview: valid && (isOwner || membership.role === "reviewer"),
    canManageMembers: isOwner,
    canRead: valid,
  };
}
export async function organizationAccessForUser(
  ctx: Ctx,
  organizationId: Id<"organizations">,
  userId: string,
) {
  const [organization, membership] = await Promise.all([
    ctx.db.get(organizationId),
    ctx.db
      .query("organizationMemberships")
      .withIndex("by_organizationId_and_userId", (q) =>
        q.eq("organizationId", organizationId).eq("userId", userId),
      )
      .unique(),
  ]);
  return {
    organization,
    membership,
    ...organizationCapabilities(organization, membership, userId),
  };
}
export async function requireOrganizationAccess(
  ctx: Ctx,
  organizationId: Id<"organizations">,
  permission: OrganizationPermission,
) {
  const session = await requireAssuredSession(ctx);
  const access = await organizationAccessForUser(
    ctx,
    organizationId,
    session.userId,
  );
  const allowed =
    permission === "read"
      ? access.canRead
      : permission === "manage"
        ? access.canManage
        : access.canReview;
  if (!allowed || (permission !== "read" && session.impersonatedBy))
    throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
  return {
    userId: session.userId,
    sessionId: session.sessionId,
    organizationId,
    organizationRole: access.membership?.role ?? "member",
    isOwner: access.isOwner,
    canManage: access.canManage && !session.impersonatedBy,
    canReview: access.canReview && !session.impersonatedBy,
    canManageMembers: access.canManageMembers && !session.impersonatedBy,
  };
}
export async function requireOrganizationOwner(
  ctx: Ctx,
  organizationId: Id<"organizations">,
  allowArchived = false,
) {
  const session = await requireAssuredSession(ctx);
  const access = await organizationAccessForUser(
    ctx,
    organizationId,
    session.userId,
  );
  const archivedOwner =
    allowArchived &&
    access.organization?.status === "archived" &&
    access.organization.ownerUserId === session.userId &&
    access.membership?.status === "active" &&
    access.membership.role === "manager";
  if ((!access.isOwner && !archivedOwner) || session.impersonatedBy)
    throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
  return {
    userId: session.userId,
    sessionId: session.sessionId,
    organizationId,
    organizationRole: "manager" as const,
    organization: access.organization!,
  };
}
export async function requireOrganizationJurisdiction(
  ctx: Ctx,
  organizationId: Id<"organizations">,
  jurisdictionId: Id<"jurisdictions">,
  permission: OrganizationPermission,
) {
  const actor = await requireOrganizationAccess(
    ctx,
    organizationId,
    permission,
  );
  const jurisdiction = await ctx.db.get(jurisdictionId);
  if (
    jurisdiction?.kind !== "organizational" ||
    jurisdiction.organizationId !== organizationId ||
    (permission !== "read" && jurisdiction.status === "archived")
  )
    throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
  return { actor, jurisdiction };
}

export async function requireOrganizationResource(
  ctx: QueryCtx | MutationCtx,
  resourceId: Id<"legalResources">,
  permission: "read" | "manage" | "review",
) {
  const resource = await ctx.db.get(resourceId);
  const jurisdiction = resource
    ? await ctx.db.get(resource.jurisdictionId)
    : null;
  if (
    !resource ||
    jurisdiction?.kind !== "organizational" ||
    !jurisdiction.organizationId
  )
    throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
  const { actor } = await requireOrganizationJurisdiction(
    ctx,
    jurisdiction.organizationId,
    jurisdiction._id,
    permission,
  );
  return { actor, resource, jurisdiction };
}
