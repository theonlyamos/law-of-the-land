import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx } from "../_generated/server";
import type { AdminRole } from "../lib/adminPermissions";
import { hasRolePermission } from "../lib/adminPermissions";
import { adminAccessError } from "../lib/adminAccessErrors";
import { normalizePositiveSafeIntegerBucketId } from "../lib/jurisdictionEligibility";
import { isLegacyCountryCode } from "../lib/jurisdictionDomain";
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

const jurisdictionDocValidator = v.object({
  _id: v.id("jurisdictions"), _creationTime: v.number(), code: v.string(), name: v.string(),
  slug: v.string(), status: jurisdictionStatusValidator, isDefault: v.boolean(),
  stagingBucketId: v.optional(v.string()), productionBucketId: v.optional(v.string()),
  providerSyncState: v.union(v.literal("pending"), v.literal("synced"), v.literal("drifted"), v.literal("failed")),
  createdBy: v.string(), updatedBy: v.string(), createdAt: v.number(), updatedAt: v.number(),
});
const resourceDocValidator = v.object({
  _id: v.id("legalResources"), _creationTime: v.number(), jurisdictionId: v.id("jurisdictions"),
  type: resourceTypeValidator, title: v.string(), issuer: v.string(), officialCitation: v.string(),
  officialCitationKey: v.string(), sourceUrl: v.string(), topics: v.array(v.string()),
  effectiveDate: v.string(), repealDate: v.optional(v.string()), status: resourceStatusValidator,
  activeVersionId: v.optional(v.id("documentVersions")), createdBy: v.string(), updatedBy: v.string(),
  createdAt: v.number(), updatedAt: v.number(),
});
const versionStatusValidator = v.union(
  v.literal("draft"), v.literal("uploading"), v.literal("staging_processing"),
  v.literal("ready_for_review"), v.literal("approved"), v.literal("publishing"),
  v.literal("published"), v.literal("rejected"), v.literal("failed"),
  v.literal("superseded"), v.literal("unpublished"), v.literal("archived"),
);
const versionDocValidator = v.object({
  _id: v.id("documentVersions"), _creationTime: v.number(), resourceId: v.id("legalResources"),
  versionNumber: v.number(), originalStorageId: v.id("_storage"), filename: v.string(),
  mimeType: v.string(), byteSize: v.number(), sha256: v.string(), sourceUrl: v.string(),
  effectiveDate: v.optional(v.string()), repealDate: v.optional(v.string()), status: versionStatusValidator,
  groundxStagingDocumentId: v.optional(v.string()), groundxStagingProcessId: v.optional(v.string()),
  xrayEvidence: v.optional(v.object({
    status: v.union(
      v.literal("queued"), v.literal("training"), v.literal("processing"), v.literal("complete"),
      v.literal("error"), v.literal("cancelled"),
    ),
    documentId: v.string(), processId: v.string(),
    fileType: v.optional(v.union(
      v.literal("txt"), v.literal("docx"), v.literal("pptx"),
      v.literal("xlsx"), v.literal("pdf"), v.literal("png"),
      v.literal("jpg"), v.literal("csv"), v.literal("tsv"), v.literal("json"),
    )),
    fileSize: v.optional(v.number()), observedAt: v.number(),
  })),
  groundxProductionDocumentId: v.optional(v.string()), groundxProductionProcessId: v.optional(v.string()),
  submittedBy: v.string(), reviewedBy: v.optional(v.string()), submittedAt: v.optional(v.number()),
  reviewedAt: v.optional(v.number()), publishedAt: v.optional(v.number()), unpublishedAt: v.optional(v.number()),
  failureSummary: v.optional(v.string()), createdAt: v.number(), updatedAt: v.number(),
});
const resourceDetailValidator = v.object({
  _id: v.id("legalResources"), _creationTime: v.number(), jurisdictionId: v.id("jurisdictions"),
  type: resourceTypeValidator, title: v.string(), issuer: v.string(), officialCitation: v.string(),
  officialCitationKey: v.string(), sourceUrl: v.string(), topics: v.array(v.string()),
  effectiveDate: v.string(), repealDate: v.optional(v.string()), status: resourceStatusValidator,
  activeVersionId: v.optional(v.id("documentVersions")), createdBy: v.string(), updatedBy: v.string(),
  createdAt: v.number(), updatedAt: v.number(),
  jurisdiction: v.object({ code: v.string(), name: v.string(), status: jurisdictionStatusValidator }),
});

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

function hasLegacyJurisdictionCode<T extends { code?: string }>(
  row: T,
): row is T & { code: string } {
  return isLegacyCountryCode(row.code);
}

function requireLegacyJurisdictionCode<T extends { code?: string }>(row: T): string {
  if (!hasLegacyJurisdictionCode(row)) {
    throw new ConvexError("JURISDICTION_NOT_FOUND");
  }
  return row.code;
}

function optionalBucket(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, "BUCKET_ID");
}

function optionalProductionBucket(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizePositiveSafeIntegerBucketId(value);
  if (normalized === null) throw new ConvexError("INVALID_PRODUCTION_BUCKET_ID");
  return normalized;
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
  if (value.length > 500) throw new ConvexError("INVALID_SOURCE_URL");
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
  if (values.length > Math.min(MAX_TOPICS, 8)) throw new ConvexError("INVALID_TOPICS");
  const topics = values.map((value) => {
    const topic = requiredText(value, "TOPIC");
    if (topic.length > 80) throw new ConvexError("INVALID_TOPIC");
    return topic;
  });
  if (new Set(topics.map((topic) => topic.toLocaleLowerCase("en"))).size !== topics.length) {
    throw new ConvexError("INVALID_TOPICS");
  }
  return topics;
}

function canonicalCitation(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function jurisdictionSnapshot(row: Pick<Doc<"jurisdictions">, "code" | "name" | "slug" | "status" | "isDefault" | "stagingBucketId" | "productionBucketId" | "providerSyncState">) {
  return {
    code: row.code, name: row.name, slug: row.slug, status: row.status, isDefault: row.isDefault,
    stagingBucketId: row.stagingBucketId ?? null, productionBucketId: row.productionBucketId ?? null,
    providerSyncState: row.providerSyncState,
  };
}

function resourceSnapshot(row: Pick<Doc<"legalResources">, "jurisdictionId" | "type" | "title" | "issuer" | "officialCitation" | "sourceUrl" | "topics" | "effectiveDate" | "repealDate" | "status" | "activeVersionId">) {
  const source = new URL(row.sourceUrl);
  return {
    jurisdictionId: row.jurisdictionId, type: row.type, title: row.title, issuer: row.issuer,
    officialCitation: row.officialCitation, sourceUrl: `${source.host}${source.pathname}${source.search}${source.hash}`, topics: row.topics,
    effectiveDate: row.effectiveDate, repealDate: row.repealDate ?? null, status: row.status,
    activeVersionId: row.activeVersionId ?? null,
  };
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
    code: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(jurisdictionDocValidator),
  handler: async (ctx, args) => {
    await requireEnabledCatalogRead(ctx, "jurisdiction");
    validatePageSize(args.paginationOpts.numItems);
    const code = args.code === undefined ? undefined : normalizeCode(args.code);
    const source = code
      ? ctx.db.query("jurisdictions").withIndex("by_code", (q) => q.eq("code", code))
      : args.status
      ? ctx.db.query("jurisdictions").withIndex("by_status_and_name", (q) => q.eq("status", args.status!))
      : ctx.db.query("jurisdictions");
    const result = await source.paginate(args.paginationOpts);
    const page = result.page.flatMap((row) => {
      if (!hasLegacyJurisdictionCode(row)) return [];
      return [{ ...row, code: row.code }];
    });
    return {
      ...result,
      page,
    };
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
    const stagingBucketId = optionalBucket(args.stagingBucketId);
    const productionBucketId = optionalProductionBucket(args.productionBucketId);
    const now = Date.now();
    const id = await ctx.db.insert("jurisdictions", {
      code,
      name: requiredText(args.name, "JURISDICTION_NAME"),
      slug,
      status: "draft",
      isDefault: args.isDefault,
      stagingBucketId,
      productionBucketId,
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
      before: JSON.stringify(null),
      after: JSON.stringify(jurisdictionSnapshot({
        code, name: requiredText(args.name, "JURISDICTION_NAME"), slug, status: "draft",
        isDefault: args.isDefault, stagingBucketId,
        productionBucketId, providerSyncState: "pending",
      })),
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
  returns: jurisdictionDocValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    const reason = validateAuditReason(args.reason);
    const row = await ctx.db.get("jurisdictions", args.id);
    if (!row) throw new ConvexError("JURISDICTION_NOT_FOUND");
    const code = requireLegacyJurisdictionCode(row);
    if (row.status === "archived") throw new ConvexError("JURISDICTION_ARCHIVED");
    const slug = normalizeSlug(args.slug);
    await assertUniqueJurisdiction(ctx, { code, slug, exceptId: row._id });
    if (args.isDefault) await assertDefaultAvailable(ctx, row._id);
    const productionBucketId = optionalProductionBucket(args.productionBucketId);
    if (row.status === "enabled" && productionBucketId === undefined) {
      throw new ConvexError("PRODUCTION_BUCKET_REQUIRED");
    }
    const patch = {
      name: requiredText(args.name, "JURISDICTION_NAME"),
      slug,
      stagingBucketId: optionalBucket(args.stagingBucketId),
      productionBucketId,
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
      before: JSON.stringify(jurisdictionSnapshot(row)),
      after: JSON.stringify(jurisdictionSnapshot({ ...row, ...patch })),
    });
    return { ...row, ...patch, code };
  },
});

export const enableJurisdiction = mutation({
  args: { id: v.id("jurisdictions"), reason: v.string() },
  returns: jurisdictionDocValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    const reason = validateAuditReason(args.reason);
    const row = await ctx.db.get("jurisdictions", args.id);
    if (!row) throw new ConvexError("JURISDICTION_NOT_FOUND");
    const code = requireLegacyJurisdictionCode(row);
    if (row.status !== "draft") throw new ConvexError("INVALID_JURISDICTION_TRANSITION");
    if (!row.productionBucketId) throw new ConvexError("PRODUCTION_BUCKET_REQUIRED");
    if (normalizePositiveSafeIntegerBucketId(row.productionBucketId) === null) {
      throw new ConvexError("INVALID_PRODUCTION_BUCKET_ID");
    }
    const patch = { status: "enabled" as const, updatedBy: actor.userId, updatedAt: Date.now() };
    await ctx.db.patch(row._id, patch);
    await auditChange(ctx, actor, {
      action: "jurisdiction.enabled",
      targetType: "jurisdiction",
      targetId: row._id,
      reason,
      before: JSON.stringify(jurisdictionSnapshot(row)),
      after: JSON.stringify(jurisdictionSnapshot({ ...row, ...patch })),
    });
    return { ...row, ...patch, code };
  },
});

export const archiveJurisdiction = mutation({
  args: { id: v.id("jurisdictions"), reason: v.string() },
  returns: jurisdictionDocValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    const reason = validateAuditReason(args.reason);
    const row = await ctx.db.get("jurisdictions", args.id);
    if (!row) throw new ConvexError("JURISDICTION_NOT_FOUND");
    const code = requireLegacyJurisdictionCode(row);
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
      before: JSON.stringify(jurisdictionSnapshot(row)),
      after: JSON.stringify(jurisdictionSnapshot({ ...row, ...patch })),
    });
    return { ...row, ...patch, code };
  },
});

export const listResources = query({
  args: {
    jurisdictionId: v.optional(v.id("jurisdictions")),
    status: v.optional(resourceStatusValidator),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(resourceDocValidator),
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
  returns: resourceDetailValidator,
  handler: async (ctx, args) => {
    await requireEnabledCatalogRead(ctx, "resource");
    const resource = await ctx.db.get("legalResources", args.id);
    if (!resource) throw new ConvexError("RESOURCE_NOT_FOUND");
    const jurisdiction = await ctx.db.get("jurisdictions", resource.jurisdictionId);
    if (!jurisdiction) throw new ConvexError("JURISDICTION_NOT_FOUND");
    const code = requireLegacyJurisdictionCode(jurisdiction);
    return {
      ...resource,
      jurisdiction: {
        code,
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
    exceptId?: Id<"legalResources">;
  },
) {
  const jurisdiction = await ctx.db.get("jurisdictions", input.jurisdictionId);
  if (!jurisdiction || jurisdiction.status === "archived") {
    throw new ConvexError("JURISDICTION_NOT_AVAILABLE");
  }
  requireLegacyJurisdictionCode(jurisdiction);
  const officialCitation = requiredText(input.officialCitation, "OFFICIAL_CITATION");
  const officialCitationKey = canonicalCitation(officialCitation);
  const citations = await ctx.db
    .query("legalResources")
    .withIndex("by_jurisdictionId_and_officialCitationKey", (q) =>
      q.eq("jurisdictionId", input.jurisdictionId).eq("officialCitationKey", officialCitationKey),
    )
    .take(2);
  if (citations.some((row) => row._id !== input.exceptId)) {
    throw new ConvexError("RESOURCE_CITATION_EXISTS");
  }
  return {
    title: requiredText(input.title, "RESOURCE_TITLE"),
    issuer: requiredText(input.issuer, "RESOURCE_ISSUER"),
    officialCitation,
    officialCitationKey,
    sourceUrl: validateSourceUrl(input.sourceUrl),
    topics: validateTopics(input.topics),
    effectiveDate: validateDate(input.effectiveDate, "EFFECTIVE_DATE"),
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
      before: JSON.stringify(null),
      after: JSON.stringify(resourceSnapshot({
        jurisdictionId: args.jurisdictionId, type, ...normalized, status: "active",
      })),
    });
    return id;
  },
});

export const updateResource = mutation({
  args: { id: v.id("legalResources"), ...resourceMutationArgs },
  returns: resourceDocValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "resource", "write");
    const reason = validateAuditReason(args.reason);
    const row = await ctx.db.get("legalResources", args.id);
    if (!row) throw new ConvexError("RESOURCE_NOT_FOUND");
    if (row.status === "archived") throw new ConvexError("RESOURCE_ARCHIVED");
    if (
      (row.status === "active" && row.repealDate !== undefined) ||
      (row.status === "repealed" && row.repealDate === undefined)
    ) throw new ConvexError("RESOURCE_STATUS_DATE_MISMATCH");
    const normalized = await resourceInput(ctx, {
      jurisdictionId: row.jurisdictionId,
      ...args,
      exceptId: row._id,
    });
    const patch = {
      ...normalized,
      ...(row.status === "repealed" ? { repealDate: row.repealDate } : {}),
      updatedBy: actor.userId,
      updatedAt: Date.now(),
    };
    await ctx.db.patch(row._id, patch);
    await auditChange(ctx, actor, {
      action: "resource.updated",
      targetType: "legalResource",
      targetId: row._id,
      reason,
      before: JSON.stringify(resourceSnapshot(row)),
      after: JSON.stringify(resourceSnapshot({ ...row, ...patch })),
    });
    return { ...row, ...patch };
  },
});

export const archiveResource = mutation({
  args: { id: v.id("legalResources"), reason: v.string() },
  returns: resourceDocValidator,
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
      before: JSON.stringify(resourceSnapshot(row)),
      after: JSON.stringify(resourceSnapshot({ ...row, ...patch })),
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
  returns: resourceDocValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "resource", "write");
    const reason = validateAuditReason(args.reason);
    const row = await ctx.db.get("legalResources", args.id);
    if (!row) throw new ConvexError("RESOURCE_NOT_FOUND");
    if (row.status !== "active") throw new ConvexError("INVALID_RESOURCE_TRANSITION");
    if (row.repealDate !== undefined) throw new ConvexError("RESOURCE_STATUS_DATE_MISMATCH");
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
      before: JSON.stringify(resourceSnapshot(row)),
      after: JSON.stringify(resourceSnapshot({ ...row, ...patch })),
    });
    return { ...row, ...patch };
  },
});

export const listVersions = query({
  args: { resourceId: v.id("legalResources"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(versionDocValidator),
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
