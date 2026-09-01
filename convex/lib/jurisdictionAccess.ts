import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS } from "./jurisdictionDomain";
import { optionalUserId } from "./requireUser";

type AccessCtx = QueryCtx | MutationCtx;

export type AccessibleJurisdiction = Pick<
  Doc<"jurisdictions">,
  "_id" | "name" | "slug"
> & {
  status: "enabled";
  kind: "geographic" | "organizational";
  visibility: "public" | "members";
};

function denied(): never {
  throw new ConvexError("JURISDICTION_ACCESS_DENIED");
}

/**
 * Returns the complete, explicitly bounded active organization set for a user.
 * A corrupted membership state fails closed rather than silently truncating
 * their jurisdiction access.
 */
export async function activeOrganizationIdsForUser(
  ctx: AccessCtx,
  userId: string,
): Promise<Set<Id<"organizations">>> {
  const memberships = await ctx.db
    .query("organizationMemberships")
    .withIndex("by_userId_and_status", (q) =>
      q.eq("userId", userId).eq("status", "active"),
    )
    .take(MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS + 1);
  if (memberships.length > MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS) {
    throw new ConvexError("ORGANIZATION_MEMBERSHIP_LIMIT");
  }
  const organizationIds = new Set(
    memberships.map((membership) => membership.organizationId),
  );
  if (organizationIds.size !== memberships.length) {
    throw new ConvexError("ORGANIZATION_MEMBERSHIP_STATE_INVALID");
  }
  return organizationIds;
}

/** Enforces public-or-active-member access for one enabled common row. */
export async function assertJurisdictionAccess(
  ctx: AccessCtx,
  jurisdiction: Doc<"jurisdictions">,
): Promise<void> {
  if (jurisdiction.status !== "enabled") denied();
  if ((jurisdiction.visibility ?? "public") === "public") return;

  const organizationId = jurisdiction.organizationId;
  const userId = await optionalUserId(ctx);
  if (!organizationId || !userId) denied();

  const activeOrganizationIds = await activeOrganizationIdsForUser(ctx, userId);
  if (!activeOrganizationIds.has(organizationId)) denied();
}

export function projectAccessibleJurisdiction(
  jurisdiction: Doc<"jurisdictions">,
): AccessibleJurisdiction {
  return {
    _id: jurisdiction._id,
    name: jurisdiction.name,
    slug: jurisdiction.slug,
    status: "enabled",
    kind: jurisdiction.kind ?? "geographic",
    visibility: jurisdiction.visibility ?? "public",
  };
}

/** Safe server-read helper. Provider configuration is deliberately omitted. */
export async function getAccessibleJurisdictionById(
  ctx: AccessCtx,
  id: Id<"jurisdictions">,
): Promise<AccessibleJurisdiction | null> {
  const jurisdiction = await ctx.db.get("jurisdictions", id);
  if (!jurisdiction) return null;
  try {
    await assertJurisdictionAccess(ctx, jurisdiction);
  } catch (error) {
    if (error instanceof ConvexError && error.message === "JURISDICTION_ACCESS_DENIED") {
      return null;
    }
    throw error;
  }
  return projectAccessibleJurisdiction(jurisdiction);
}
