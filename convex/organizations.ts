import { requireAssuredSession } from "./lib/requireAdmin";
import { v, ConvexError } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireOrganizationAccess } from "./lib/organizationAccess";
import { bumpContentRevision, bumpWidgetAccessVersion } from "./lib/widgetAuthority";
import { consumeStepUp } from "./admin/publication";
import { writeAudit, validateAuditReason } from "./admin/audit";

export const setVisibility = mutation({
  args: { organizationId: v.id("organizations"), visibility: v.union(v.literal("public"), v.literal("members")), confirmation: v.string(), idempotencyKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireOrganizationAccess(ctx, args.organizationId, "manage");
    const jurisdiction = await ctx.db.query("jurisdictions").withIndex("by_organizationId", q => q.eq("organizationId", args.organizationId)).unique();
    if (!jurisdiction || jurisdiction.kind !== "organizational" || jurisdiction.status === "archived") throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
    if (args.confirmation !== `${args.visibility === "public" ? "PUBLIC" : "PRIVATE"} ${jurisdiction._id}`) throw new ConvexError("ADMIN_CONFIRMATION_MISMATCH");
    await consumeStepUp(ctx, actor.userId, actor.sessionId, "organization_visibility", jurisdiction._id, args.idempotencyKey);
    if (jurisdiction.visibility === args.visibility) return null;
    await ctx.db.patch(jurisdiction._id, { visibility: args.visibility, updatedAt: Date.now(), updatedBy: actor.userId });
    await bumpWidgetAccessVersion(ctx, jurisdiction._id);
    await bumpContentRevision(ctx, jurisdiction._id);
    await writeAudit(ctx, { actorId: actor.userId, actorRoles: [], organizationId: actor.organizationId, organizationRole: actor.organizationRole, action: "organization.visibility_set", targetType: "jurisdiction", targetId: jurisdiction._id, beforeSummary: jurisdiction.visibility, afterSummary: args.visibility, outcome: "success" });
    return null;
  },
});

export const getWorkspace = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    const actor = await requireOrganizationAccess(ctx, organizationId, "read");
    const organization = await ctx.db.get(organizationId);
    const rows = await ctx.db.query("jurisdictions").withIndex("by_organizationId", q => q.eq("organizationId", organizationId)).take(2);
    if (rows.length > 1) throw new ConvexError("ORGANIZATION_JURISDICTION_STATE_INVALID");
    const jurisdiction = rows[0];
    const resource = jurisdiction ? await ctx.db.query("legalResources").withIndex("by_jurisdictionId_and_activeVersionId", q => q.eq("jurisdictionId", jurisdiction._id).gt("activeVersionId", undefined)).first() : null;
    const version = resource?.activeVersionId ? await ctx.db.get(resource.activeVersionId) : null;
    return { organization: { id: organizationId, name: organization!.name }, role: actor.organizationRole, hasPublishedDocuments: resource?.status === "active" && version?.status === "published" && version.resourceId === resource._id,
      jurisdiction: jurisdiction ? { id: jurisdiction._id, name: jurisdiction.name, visibility: jurisdiction.visibility, status: jurisdiction.status } : null,
      canManage: actor.organizationRole === "manager", canReview: actor.organizationRole === "reviewer" };
  },
});

export const listMine = query({ args: {}, handler: async ctx => {
  const session = await requireAssuredSession(ctx);
  const memberships = await ctx.db.query("organizationMemberships").withIndex("by_userId_and_status", q => q.eq("userId", session.userId).eq("status", "active")).take(21);
  return (await Promise.all(memberships.map(async member => { const organization = await ctx.db.get(member.organizationId); return organization?.status === "active" ? { id: organization._id, name: organization.name, role: member.role ?? "member" } : null; }))).filter(row => row !== null);
} });

export const setPresentation = mutation({ args: { organizationId: v.id("organizations"), name: v.string(), reason: v.string() }, returns: v.null(), handler: async (ctx, args) => {
  const actor = await requireOrganizationAccess(ctx, args.organizationId, "manage");
  const jurisdiction = await ctx.db.query("jurisdictions").withIndex("by_organizationId", q => q.eq("organizationId", args.organizationId)).unique();
  if (jurisdiction?.kind !== "organizational" || jurisdiction.status === "archived") throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
  const name = args.name.trim().replace(/\s+/g, " "), reason = validateAuditReason(args.reason);
  if (!name || name.length > 300) throw new ConvexError("INVALID_JURISDICTION_NAME");
  if (name === jurisdiction.name) return null;
  await ctx.db.patch(jurisdiction._id, { name, updatedAt: Date.now(), updatedBy: actor.userId });
  await bumpContentRevision(ctx, jurisdiction._id);
  await writeAudit(ctx, { actorId: actor.userId, actorRoles: [], organizationId: actor.organizationId, organizationRole: actor.organizationRole, action: "organization.presentation_updated", targetType: "jurisdiction", targetId: jurisdiction._id, reason, outcome: "success" });
  return null;
} });