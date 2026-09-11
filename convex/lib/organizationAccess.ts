import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { requireAssuredSession } from "./requireAdmin";

export async function requireOrganizationAccess(ctx: QueryCtx | MutationCtx, organizationId: Id<"organizations">, permission: "read" | "manage" | "review") {
  const session = await requireAssuredSession(ctx);
  const [organization, membership] = await Promise.all([
    ctx.db.get(organizationId),
    ctx.db.query("organizationMemberships").withIndex("by_organizationId_and_userId", q => q.eq("organizationId", organizationId).eq("userId", session.userId)).unique(),
  ]);
  const role = membership?.role ?? "member";
  if (!organization || organization.status !== "active" || membership?.status !== "active" ||
    (permission !== "read" && session.impersonatedBy) ||
    !(permission === "read" || (permission === "manage" && role === "manager") || (permission === "review" && role === "reviewer"))) {
    throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
  }
  return { userId: session.userId, sessionId: session.sessionId, organizationId, organizationRole: role };
}

export async function requireOrganizationResource(ctx: QueryCtx | MutationCtx, resourceId: Id<"legalResources">, permission: "read" | "manage" | "review") {
  const resource = await ctx.db.get(resourceId);
  const jurisdiction = resource ? await ctx.db.get(resource.jurisdictionId) : null;
  if (!resource || jurisdiction?.kind !== "organizational" || !jurisdiction.organizationId) throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
  const actor = await requireOrganizationAccess(ctx, jurisdiction.organizationId, permission);
  return { actor, resource, jurisdiction };
}
