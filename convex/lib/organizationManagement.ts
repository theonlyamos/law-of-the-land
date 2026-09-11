import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { authComponent } from "../auth";
import { requireAssuredSession } from "./requireAdmin";
import { MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS } from "./jurisdictionDomain";
import { consumeRateBucket } from "./rateBuckets";

export const MAX_OWNED_ORGANIZATIONS = 5;
export const MAX_ORGANIZATION_JURISDICTIONS = 20;
export const MAX_ORGANIZATION_INVITATIONS = 20;
export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60_000;
export function organizationName(value: string) {
  const name = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!name || name.length > 300)
    throw new ConvexError("INVALID_ORGANIZATION_NAME");
  return name;
}
export function organizationWebsite(value?: string) {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (
      value.length > 500 ||
      url.protocol !== "https:" ||
      url.username ||
      url.password
    )
      throw new Error();
    return url.toString();
  } catch {
    throw new ConvexError("INVALID_ORGANIZATION_WEBSITE");
  }
}
export function discoveryText(organization: string, jurisdiction: string) {
  return `${organization} ${jurisdiction}`
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}
export function validatePageSize(size: number) {
  if (!Number.isInteger(size) || size < 1 || size > 50)
    throw new ConvexError("INVALID_PAGINATION");
}
export async function verifiedOrganizationUser(ctx: QueryCtx | MutationCtx) {
  const session = await requireAssuredSession(ctx);
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user?.emailVerified || session.impersonatedBy)
    throw new ConvexError("ORGANIZATION_VERIFIED_ACCOUNT_REQUIRED");
  return { ...session, email: user.email.trim().toLowerCase() };
}
export async function assertMembershipCapacity(
  ctx: MutationCtx,
  userId: string,
) {
  const rows = await ctx.db
    .query("organizationMemberships")
    .withIndex("by_userId_and_status", (q) =>
      q.eq("userId", userId).eq("status", "active"),
    )
    .take(MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS);
  if (rows.length >= MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS)
    throw new ConvexError("ORGANIZATION_MEMBERSHIP_LIMIT");
}
export async function assertOwnerCapacity(ctx: MutationCtx, userId: string) {
  const rows = await ctx.db
    .query("organizations")
    .withIndex("by_ownerUserId_and_status", (q) =>
      q.eq("ownerUserId", userId).eq("status", "active"),
    )
    .take(MAX_OWNED_ORGANIZATIONS);
  if (rows.length >= MAX_OWNED_ORGANIZATIONS)
    throw new ConvexError("ORGANIZATION_OWNER_LIMIT");
}
export async function currentOrganizationJurisdictions(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
) {
  const rows = (
    await Promise.all(
      (["draft", "enabled"] as const).map((status) =>
        ctx.db
          .query("jurisdictions")
          .withIndex("by_organizationId_and_status_and_name", (q) =>
            q.eq("organizationId", organizationId).eq("status", status),
          )
          .take(MAX_ORGANIZATION_JURISDICTIONS + 1),
      ),
    )
  ).flat();
  if (rows.length > MAX_ORGANIZATION_JURISDICTIONS)
    throw new ConvexError("ORGANIZATION_JURISDICTION_LIMIT");
  return rows;
}
export async function singleOrganizationJurisdiction(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
) {
  const rows = await currentOrganizationJurisdictions(ctx, organizationId);
  if (rows.length !== 1)
    throw new ConvexError("ORGANIZATION_JURISDICTION_SELECTION_REQUIRED");
  return rows[0];
}
export async function uniqueOrganizationSlug(
  ctx: MutationCtx,
  table: "organizations" | "jurisdictions",
  value: string,
) {
  const base =
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60)
      .replace(/-$/, "") || "organization";
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = attempt ? `${base}-${crypto.randomUUID().slice(0, 8)}` : base;
    if (
      !(await ctx.db
        .query(table)
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .first())
    )
      return slug;
  }
  throw new ConvexError("ORGANIZATION_SLUG_EXISTS");
}
export async function organizationRate(
  ctx: MutationCtx,
  namespace: string,
  userId: string,
  limit: number,
) {
  const retryAfterSeconds = await consumeRateBucket(
    ctx,
    namespace,
    userId,
    limit,
    3_600_000,
  );
  if (retryAfterSeconds)
    throw new ConvexError({
      code: "ORGANIZATION_RATE_LIMITED",
      retryAfterSeconds,
    });
}
export async function organizationOperation(
  ctx: MutationCtx,
  actorId: string,
  action: string,
  key: string,
  payload: Record<string, unknown>,
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key))
    throw new ConvexError("ADMIN_INVALID_IDEMPOTENCY_KEY");
  const fingerprint = JSON.stringify(
    Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)),
  );
  const old = await ctx.db
    .query("adminOperations")
    .withIndex("by_actorId_and_idempotencyKey", (q) =>
      q.eq("actorId", actorId).eq("idempotencyKey", key),
    )
    .unique();
  if (old && (old.action !== action || old.requestFingerprint !== fingerprint))
    throw new ConvexError("ORGANIZATION_REQUEST_CONFLICT");
  return { old, fingerprint };
}
export async function finishOrganizationOperation(
  ctx: MutationCtx,
  actorId: string,
  action: string,
  key: string,
  fingerprint: string,
  targetId: string,
) {
  const now = Date.now(),
    correlationId = crypto.randomUUID();
  await ctx.db.insert("adminOperations", {
    actorId,
    action,
    targetId,
    idempotencyKey: key,
    requestFingerprint: fingerprint,
    correlationId,
    status: "succeeded",
    result: { status: "succeeded", correlationId, action, targetId },
    createdAt: now,
    updatedAt: now,
  });
}
