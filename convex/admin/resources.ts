import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx } from "../_generated/server";
import type { AdminRole } from "../lib/adminPermissions";
import { hasRolePermission } from "../lib/adminPermissions";
import { adminAccessError } from "../lib/adminAccessErrors";
import { requireCurrentAdmin } from "../lib/requireAdmin";
import { validateAuditReason, writeAudit } from "./audit";
import { readAdminEnabled, requireEnabledAdminPermission } from "./featureFlags";

const MAX_PAGE_SIZE = 100;
const MAX_TEXT_LENGTH = 300;
const MAX_TOPICS = 25;

const jurisdictionStatusValidator = v.union(
  v.literal("draft"),
  v.literal("enabled"),
  v.literal("archived"),
);
const resourceStatusValidator = v.union(
  v.literal("active"),
  v.literal("repealed"),
  v.literal("archived"),
);
const resourceTypeValidator = v.union(
  v.literal("constitution"),
  v.literal("act"),
  v.literal("regulation"),
  v.literal("ordinance"),
  v.literal("judgment"),
  v.literal("policy"),
  v.literal("guidance"),
);

type Actor = { userId: string; roles: AdminRole[] };
type ResourceType = Doc<"legalResources">["type"];

function validatePageSize(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new ConvexError("INVALID_ADMIN_PAGINATION");
  }
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_TEXT_LENGTH) {
    throw new ConvexError(`INVALID_${field.toUpperCase()}`);
  }
  return normalized;
}

function normalizeCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new ConvexError("INVALID_JURISDICTION_CODE");
  }
  return code;
}

function normalizeSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
    throw new ConvexError("INVALID_JURISDICTION_SLUG");
  }
  return slug;
}

function optionalBucket(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, "BUCKET_ID");
}

function validateResourceType(value: string): ResourceType {
  const values: readonly string[] = [
    "constitution",
    "act",
    "regulation",
    "ordinance",
    "judgment",
    "policy",
    "guidance",
  ];
  if (!values.includes(value)) {
    throw new ConvexError("INVALID_RESOURCE_TYPE");
  }
  return value as ResourceType;
}

function validateDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ConvexError(`INVALID_${field.toUpperCase()}`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ConvexError(`INVALID_${field.toUpperCase()}`);
  }
  return value;
}

function validateSourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConvexError("INVALID_SOURCE_URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ConvexError("INVALID_SOURCE_URL");
  }
  return url.toString();
}

function validateTopics(values: string[]): string[] {
  if (values.length > MAX_TOPICS) throw new ConvexError("INVALID_TOPICS");
  const topics = values.map((value) => requiredText(value, "TOPIC"));
  if (new Set(topics.map((topic) => topic.toLocaleLowerCase("en"))).size !== topics.length) {
    throw new ConvexError("INVALID_TOPICS");
  }
  return topics;
}

function validateDates(effectiveDate: string, repealDate?: string) {
  const effective = validateDate(effectiveDate, "EFFECTIVE_DATE");
  const repeal = repealDate === undefined ? undefined : validateDate(repealDate, "REPEAL_DATE");
  if (repeal && repeal < effective) throw new ConvexError("INVALID_DATE_RANGE");
  return { effectiveDate: effective, repealDate: repeal };
}

async function assertUniqueJurisdiction(
  ctx: MutationCtx,
  input: { code: string; slug: string; exceptId?: Id<"jurisdictions"> },
) {
  const [codes, slugs] = await Promise.all([
    ctx.db.query("jurisdictions").withIndex("by_code", (q) => q.eq("code", input.code)).take(2),
    ctx.db.query("jurisdictions").withIndex("by_slug", (q) => q.eq("slug", input.slug)).take(2),
  ]);
  if (codes.some((row) => row._id !== input.exceptId)) {
    throw new ConvexError("JURISDICTION_CODE_EXISTS");
  }
  if (slugs.some((row) => row._id !== input.exceptId)) {
    throw new ConvexError("JURISDICTION_SLUG_EXISTS");
  }
}

async function assertDefaultAvailable(ctx: MutationCtx, exceptId?: Id<"jurisdictions">) {
  const defaults = await ctx.db
    .query("jurisdictions")
    .withIndex("by_isDefault", (q) => q.eq("isDefault", true))
    .take(2);
  if (defaults.some((row) => row._id !== exceptId && row.status !== "archived")) {
    throw new ConvexError("DEFAULT_JURISDICTION_EXISTS");
  }
}

async function auditChange(
  ctx: MutationCtx,
  actor: Actor,
  input: {
    action: string;
    targetType: "jurisdiction" | "legalResource";
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

async function requireEnabledCatalogRead(
  ctx: Parameters<typeof requireCurrentAdmin>[0],
  resource: "jurisdiction" | "resource",
) {
  const actor = await requireCurrentAdmin(ctx);
  if (!(await readAdminEnabled(ctx))) {
    throw adminAccessError("ADMIN_DISABLED", "Administration is not enabled");
  }
  if (
    !hasRolePermission(actor.roles, resource, "read") &&
    !hasRolePermission(actor.roles, resource, "write")
  ) {
    throw adminAccessError("ADMIN_FORBIDDEN", "Admin permission required");
  }
  return actor;
}

export const listJurisdictions = query({
  args: {
    status: v.optional(jurisdictionStatusValidator),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireEnabledCatalogRead(ctx, "jurisdiction");
    validatePageSize(args.paginationOpts.numItems);
    const source = args.status
      ? ctx.db.query("jurisdictions").withIndex("by_status_and_name", (q) => q.eq("status", args.status!))
      : ctx.db.query("jurisdictions");
    return await source.paginate(args.paginationOpts);
  },
});

export const createJurisdiction = mutation({
  args: {
    code: v.string(),
    name: v.string(),
    slug: v.string(),
    stagingBucketId: v.optional(v.string()),
    productionBucketId: v.optional(v.string()),
    isDefault: v.boolean(),
    reason: v.string(),
  },
  returns: v.id("jurisdictions"),
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    const reason = validateAuditReason(args.reason);
    const code = normalizeCode(args.code);
    const slug = normalizeSlug(args.slug);
    await assertUniqueJurisdiction(ctx, { code, slug });
    if (args.isDefault) await assertDefaultAvailable(ctx);
    const now = Date.now();
    const id = await ctx.db.insert("jurisdictions", {
      code,
      name: requiredText(args.name, "JURISDICTION_NAME"),
      slug,
      status: "draft",
      isDefault: args.isDefault,
      stagingBucketId: optionalBucket(args.stagingBucketId),
      productionBucketId: optionalBucket(args.productionBucketId),
      providerSyncState: "pending",
      createdBy: actor.userId,
      updatedBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    });
    await auditChange(ctx, actor, {
      action: "jurisdiction.created",
      targetType: "jurisdiction",
      targetId: id,
      reason,
      after: JSON.stringify({ code, slug, status: "draft" }),
    });
    return id;
  },
});

export const updateJurisdiction = mutation({
  args: {
    id: v.id("jurisdictions"),
    name: v.string(),
    slug: v.string(),
    stagingBucketId: v.optional(v.string()),
    productionBucketId: v.optional(v.string()),
    isDefault: v.boolean(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    const reason = validateAuditReason(args.reason);
    const row = await ctx.db.get("jurisdictions", args.id);
    if (!row) throw new ConvexError("JURISDICTION_NOT_FOUND");
    if (row.status === "archived") throw new ConvexError("JURISDICTION_ARCHIVED");
    const slug = normalizeSlug(args.slug);
    await assertUniqueJurisdiction(ctx, { code: row.code, slug, exceptId: row._id });
    if (args.isDefault) await assertDefaultAvailable(ctx, row._id);
    const patch = {
      name: requiredText(args.name, "JURISDICTION_NAME"),
      slug,
      stagingBucketId: optionalBucket(args.stagingBucketId),
      productionBucketId: optionalBucket(args.productionBucketId),
      isDefault: args.isDefault,
      providerSyncState: "pending" as const,
      updatedBy: actor.userId,
      updatedAt: Date.now(),
    };
    await ctx.db.patch(row._id, patch);
    await auditChange(ctx, actor, {
      action: "jurisdiction.updated",
      targetType: "jurisdiction",
      targetId: row._id,
      reason,
      before: JSON.stringify({ name: row.name, slug: row.slug }),
      after: JSON.stringify({ name: patch.name, slug: patch.slug }),
    });
    return { ...row, ...patch };
  },
});

export const enableJurisdiction = mutation({
  args: { id: v.id("jurisdictions"), reason: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    const reason = validateAuditReason(args.reason);
    const row = await ctx.db.get("jurisdictions", args.id);
    if (!row) throw new ConvexError("JURISDICTION_NOT_FOUND");
    if (row.status !== "draft") throw new ConvexError("INVALID_JURISDICTION_TRANSITION");
    if (!row.productionBucketId) throw new ConvexError("PRODUCTION_BUCKET_REQUIRED");
    const patch = { status: "enabled" as const, updatedBy: actor.userId, updatedAt: Date.now() };
    await ctx.db.patch(row._id, patch);
    await auditChange(ctx, actor, {
      action: "jurisdiction.enabled",
      targetType: "jurisdiction",
      targetId: row._id,
      reason,
      before: JSON.stringify({ status: row.status }),
      after: JSON.stringify({ status: patch.status }),
    });
    return { ...row, ...patch };
  },
});

export const archiveJurisdiction = mutation({
  args: { id: v.id("jurisdictions"), reason: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    const reason = validateAuditReason(args.reason);
    const row = await ctx.db.get("jurisdictions", args.id);
    if (!row) throw new ConvexError("JURISDICTION_NOT_FOUND");
    if (row.status === "archived") throw new ConvexError("INVALID_JURISDICTION_TRANSITION");
    const active = await ctx.db
      .query("legalResources")
      .withIndex("by_jurisdictionId_and_status", (q) =>
        q.eq("jurisdictionId", row._id).eq("status", "active"),
      )
      .take(1);
    if (active.length > 0) throw new ConvexError("Jurisdiction has active resources");
    const patch = {
      status: "archived" as const,
      isDefault: false,
      updatedBy: actor.userId,
      updatedAt: Date.now(),
    };
    await ctx.db.patch(row._id, patch);
    await auditChange(ctx, actor, {
      action: "jurisdiction.archived",
      targetType: "jurisdiction",
      targetId: row._id,
      reason,
      before: JSON.stringify({ status: row.status }),
      after: JSON.stringify({ status: patch.status }),
    });
    return { ...row, ...patch };
  },
});

export const listResources = query({
  args: {
    jurisdictionId: v.optional(v.id("jurisdictions")),
    status: v.optional(resourceStatusValidator),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireEnabledCatalogRead(ctx, "resource");
    validatePageSize(args.paginationOpts.numItems);
    const source = args.jurisdictionId && args.status
      ? ctx.db.query("legalResources").withIndex("by_jurisdictionId_and_status", (q) =>
          q.eq("jurisdictionId", args.jurisdictionId!).eq("status", args.status!),
        )
      : args.status
        ? ctx.db.query("legalResources").withIndex("by_status_and_updatedAt", (q) => q.eq("status", args.status!))
        : args.jurisdictionId
          ? ctx.db.query("legalResources").withIndex("by_jurisdictionId_and_updatedAt", (q) =>
              q.eq("jurisdictionId", args.jurisdictionId!),
            )
          : ctx.db.query("legalResources");
    return await source.paginate(args.paginationOpts);
  },
});

export const getResource = query({
  args: { id: v.id("legalResources") },
  handler: async (ctx, args) => {
    await requireEnabledCatalogRead(ctx, "resource");
    const resource = await ctx.db.get("legalResources", args.id);
    if (!resource) throw new ConvexError("RESOURCE_NOT_FOUND");
    const jurisdiction = await ctx.db.get("jurisdictions", resource.jurisdictionId);
    if (!jurisdiction) throw new ConvexError("JURISDICTION_NOT_FOUND");
    return {
      ...resource,
      jurisdiction: {
        code: jurisdiction.code,
        name: jurisdiction.name,
        status: jurisdiction.status,
      },
    };
  },
});

const resourceMutationArgs = {
  title: v.string(),
  issuer: v.string(),
  officialCitation: v.string(),
  sourceUrl: v.string(),
  topics: v.array(v.string()),
  effectiveDate: v.string(),
  repealDate: v.optional(v.string()),
  reason: v.string(),
} as const;

async function resourceInput(
  ctx: MutationCtx,
  input: {
    jurisdictionId: Id<"jurisdictions">;
    title: string;
    issuer: string;
    officialCitation: string;
    sourceUrl: string;
    topics: string[];
    effectiveDate: string;
    repealDate?: string;
    exceptId?: Id<"legalResources">;
  },
) {
  const jurisdiction = await ctx.db.get("jurisdictions", input.jurisdictionId);
  if (!jurisdiction || jurisdiction.status === "archived") {
    throw new ConvexError("JURISDICTION_NOT_AVAILABLE");
  }
  const officialCitation = requiredText(input.officialCitation, "OFFICIAL_CITATION");
  const citations = await ctx.db
    .query("legalResources")
    .withIndex("by_jurisdictionId_and_officialCitation", (q) =>
      q.eq("jurisdictionId", input.jurisdictionId).eq("officialCitation", officialCitation),
    )
    .take(2);
  if (citations.some((row) => row._id !== input.exceptId)) {
    throw new ConvexError("RESOURCE_CITATION_EXISTS");
  }
  const dates = validateDates(input.effectiveDate, input.repealDate);
  return {
    title: requiredText(input.title, "RESOURCE_TITLE"),
    issuer: requiredText(input.issuer, "RESOURCE_ISSUER"),
    officialCitation,
    sourceUrl: validateSourceUrl(input.sourceUrl),
    topics: validateTopics(input.topics),
    ...dates,
  };
}

export const createResource = mutation({
  args: { jurisdictionId: v.id("jurisdictions"), type: v.string(), ...resourceMutationArgs },
  returns: v.id("legalResources"),
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "resource", "write");
    const reason = validateAuditReason(args.reason);
    const type = validateResourceType(args.type);
    const normalized = await resourceInput(ctx, args);
    const now = Date.now();
    const id = await ctx.db.insert("legalResources", {
      jurisdictionId: args.jurisdictionId,
      type,
      ...normalized,
      status: "active",
      createdBy: actor.userId,
      updatedBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("resourceVersionCounters", {
      resourceId: id,
      nextVersionNumber: 1,
      updatedAt: now,
    });
    await auditChange(ctx, actor, {
      action: "resource.created",
      targetType: "legalResource",
      targetId: id,
      reason,
      after: JSON.stringify({ jurisdictionId: args.jurisdictionId, type, status: "active" }),
    });
    return id;
  },
});

export const updateResource = mutation({
  args: { id: v.id("legalResources"), ...resourceMutationArgs },
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "resource", "write");
    const reason = validateAuditReason(args.reason);
    const row = await ctx.db.get("legalResources", args.id);
    if (!row) throw new ConvexError("RESOURCE_NOT_FOUND");
    if (row.status === "archived") throw new ConvexError("RESOURCE_ARCHIVED");
    const normalized = await resourceInput(ctx, {
      jurisdictionId: row.jurisdictionId,
      ...args,
      exceptId: row._id,
    });
    const patch = { ...normalized, updatedBy: actor.userId, updatedAt: Date.now() };
    await ctx.db.patch(row._id, patch);
    await auditChange(ctx, actor, {
      action: "resource.updated",
      targetType: "legalResource",
      targetId: row._id,
      reason,
      before: JSON.stringify({ title: row.title, officialCitation: row.officialCitation }),
      after: JSON.stringify({ title: patch.title, officialCitation: patch.officialCitation }),
    });
    return { ...row, ...patch };
  },
});

export const archiveResource = mutation({
  args: { id: v.id("legalResources"), reason: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "resource", "write");
    const reason = validateAuditReason(args.reason);
    const row = await ctx.db.get("legalResources", args.id);
    if (!row) throw new ConvexError("RESOURCE_NOT_FOUND");
    if (row.status === "archived") throw new ConvexError("INVALID_RESOURCE_TRANSITION");
    const patch = { status: "archived" as const, updatedBy: actor.userId, updatedAt: Date.now() };
    await ctx.db.patch(row._id, patch);
    await auditChange(ctx, actor, {
      action: "resource.archived",
      targetType: "legalResource",
      targetId: row._id,
      reason,
      before: JSON.stringify({ status: row.status }),
      after: JSON.stringify({ status: patch.status }),
    });
    return { ...row, ...patch };
  },
});

export const markResourceRepealed = mutation({
  args: {
    id: v.id("legalResources"),
    repealDate: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "resource", "write");
    const reason = validateAuditReason(args.reason);
    const row = await ctx.db.get("legalResources", args.id);
    if (!row) throw new ConvexError("RESOURCE_NOT_FOUND");
    if (row.status !== "active") throw new ConvexError("INVALID_RESOURCE_TRANSITION");
    const repealDate = validateDate(args.repealDate, "REPEAL_DATE");
    if (repealDate < row.effectiveDate) throw new ConvexError("INVALID_DATE_RANGE");
    const patch = {
      status: "repealed" as const,
      repealDate,
      updatedBy: actor.userId,
      updatedAt: Date.now(),
    };
    await ctx.db.patch(row._id, patch);
    await auditChange(ctx, actor, {
      action: "resource.repealed",
      targetType: "legalResource",
      targetId: row._id,
      reason,
      before: JSON.stringify({ status: row.status, repealDate: row.repealDate ?? null }),
      after: JSON.stringify({ status: patch.status, repealDate }),
    });
    return { ...row, ...patch };
  },
});

export const listVersions = query({
  args: { resourceId: v.id("legalResources"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, "document", "read");
    validatePageSize(args.paginationOpts.numItems);
    return await ctx.db
      .query("documentVersions")
      .withIndex("by_resourceId_and_versionNumber", (q) => q.eq("resourceId", args.resourceId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
