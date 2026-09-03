import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx } from "../_generated/server";
import type { AdminRole } from "../lib/adminPermissions";
import { isLegacyCountryCode } from "../lib/jurisdictionDomain";
import { validateAuditReason, writeAudit } from "./audit";
import {
  requireEnabledAdminCatalogRead,
  requireEnabledAdminPermission,
} from "./featureFlags";
import {
  archiveJurisdictionForActor,
  createLegacyJurisdictionForActor,
  enableJurisdictionForActor,
  updateLegacyJurisdictionForActor,
} from "./jurisdictions";

const MAX_PAGE_SIZE = 100;
const MAX_TEXT_LENGTH = 300;
const MAX_TOPICS = 25;
const MAX_LEGACY_JURISDICTIONS = 26 * 26;
const LEGACY_PAGE_CURSOR_PREFIX = "legacy-country-code:";

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
  jurisdiction: v.object({
    code: v.optional(v.string()),
    name: v.string(),
    status: jurisdictionStatusValidator,
  }),
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

function legacyPageCursor(cursor: string | null): string | null {
  if (cursor === null || cursor === "") return null;
  if (!cursor.startsWith(LEGACY_PAGE_CURSOR_PREFIX)) {
    throw new ConvexError("INVALID_ADMIN_PAGINATION");
  }
  const code = cursor.slice(LEGACY_PAGE_CURSOR_PREFIX.length);
  if (!isLegacyCountryCode(code)) {
    throw new ConvexError("INVALID_ADMIN_PAGINATION");
  }
  return code;
}

function projectLegacyJurisdiction(row: Doc<"jurisdictions">) {
  return {
    _id: row._id,
    _creationTime: row._creationTime,
    code: requireLegacyJurisdictionCode(row),
    name: row.name,
    slug: row.slug,
    status: row.status,
    isDefault: row.isDefault,
    providerSyncState: row.providerSyncState,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function projectPickerJurisdiction(row: Doc<"jurisdictions">) {
  return {
    _id: row._id,
    _creationTime: row._creationTime,
    code: row.code ?? row.legacyCountryCode ?? row.slug,
    name: row.name,
    slug: row.slug,
    status: row.status,
    isDefault: row.isDefault,
    providerSyncState: row.providerSyncState,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function projectVersion(row: Doc<"documentVersions">) {
  return {
    _id: row._id,
    _creationTime: row._creationTime,
    resourceId: row.resourceId,
    versionNumber: row.versionNumber,
    originalStorageId: row.originalStorageId,
    filename: row.filename,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    sourceUrl: row.sourceUrl,
    ...(row.effectiveDate === undefined ? {} : { effectiveDate: row.effectiveDate }),
    ...(row.repealDate === undefined ? {} : { repealDate: row.repealDate }),
    status: row.status,
    submittedBy: row.submittedBy,
    ...(row.reviewedBy === undefined ? {} : { reviewedBy: row.reviewedBy }),
    ...(row.submittedAt === undefined ? {} : { submittedAt: row.submittedAt }),
    ...(row.reviewedAt === undefined ? {} : { reviewedAt: row.reviewedAt }),
    ...(row.publishedAt === undefined ? {} : { publishedAt: row.publishedAt }),
    ...(row.unpublishedAt === undefined ? {} : { unpublishedAt: row.unpublishedAt }),
    ...(row.failureSummary === undefined ? {} : { failureSummary: row.failureSummary }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function legacyJurisdictionProjection(
  rows: Doc<"jurisdictions">[],
  status: Doc<"jurisdictions">["status"] | undefined,
) {
  if (rows.length > MAX_LEGACY_JURISDICTIONS) return [];

  const rowsByCode = new Map<string, Doc<"jurisdictions">[]>();
  for (const row of rows) {
    if (!hasLegacyJurisdictionCode(row)) continue;
    const rowsForCode = rowsByCode.get(row.code);
    if (rowsForCode) rowsForCode.push(row);
    else rowsByCode.set(row.code, [row]);
  }

  const projection: Array<ReturnType<typeof projectLegacyJurisdiction>> = [];
  for (const rowsForCode of rowsByCode.values()) {
    if (rowsForCode.length !== 1) continue;
    const row = rowsForCode[0];
    if (status !== undefined && row.status !== status) continue;
    projection.push(projectLegacyJurisdiction(row));
  }
  return projection;
}

function legacyJurisdictionPage(
  rows: Doc<"jurisdictions">[],
  status: Doc<"jurisdictions">["status"] | undefined,
  paginationOpts: { numItems: number; cursor: string | null },
) {
  const projection = legacyJurisdictionProjection(rows, status);
  const cursorCode = legacyPageCursor(paginationOpts.cursor);
  const start = cursorCode === null
    ? 0
    : projection.findIndex((row) => row.code > cursorCode);
  const pageStart = start < 0 ? projection.length : start;
  const page = projection.slice(pageStart, pageStart + paginationOpts.numItems);
  const isDone = pageStart + page.length >= projection.length;
  return {
    isDone,
    continueCursor: isDone || page.length === 0
      ? ""
      : `${LEGACY_PAGE_CURSOR_PREFIX}${page[page.length - 1].code}`,
    page,
  };
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

function resourceSnapshot(row: Pick<Doc<"legalResources">, "jurisdictionId" | "type" | "title" | "issuer" | "officialCitation" | "sourceUrl" | "topics" | "effectiveDate" | "repealDate" | "status" | "activeVersionId">) {
  const source = new URL(row.sourceUrl);
  return {
    jurisdictionId: row.jurisdictionId, type: row.type, title: row.title, issuer: row.issuer,
    officialCitation: row.officialCitation, sourceUrl: `${source.host}${source.pathname}${source.search}${source.hash}`, topics: row.topics,
    effectiveDate: row.effectiveDate, repealDate: row.repealDate ?? null, status: row.status,
    activeVersionId: row.activeVersionId ?? null,
  };
}

async function assertNoActiveGeminiStoreTeardown(
  ctx: MutationCtx,
  jurisdictionId: Id<"jurisdictions">,
): Promise<void> {
  const jobs = await Promise.all(([
    "queued", "running", "waiting_provider", "manual_review",
  ] as const).map(async (status) => await ctx.db.query("integrationJobs")
    .withIndex("by_targetType_and_targetId_and_type_and_status", (q) => q
      .eq("targetType", "jurisdictionGeminiStore")
      .eq("targetId", jurisdictionId)
      .eq("type", "gemini_delete_store")
      .eq("status", status))
    .take(1)));
  if (jobs.some((rows) => rows.length > 0)) {
    throw new ConvexError("GEMINI_STORE_TEARDOWN_IN_PROGRESS");
  }
}

async function auditChange(
  ctx: MutationCtx,
  actor: Actor,
  input: {
    action: string;
    targetType: "legalResource";
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

export const listJurisdictions = query({
  args: {
    status: v.optional(jurisdictionStatusValidator),
    code: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(jurisdictionDocValidator),
  handler: async (ctx, args) => {
    await requireEnabledAdminCatalogRead(ctx, "jurisdiction");
    validatePageSize(args.paginationOpts.numItems);
    const code = args.code === undefined ? undefined : normalizeCode(args.code);
    if (code) {
      const [codeRows, legacyCodeRows] = await Promise.all([
        ctx.db
          .query("jurisdictions")
          .withIndex("by_code", (q) => q.eq("code", code))
          .take(2),
        args.status === undefined
          ? ctx.db
            .query("jurisdictions")
            .withIndex("by_legacyCountryCode_and_status", (q) => q.eq("legacyCountryCode", code))
            .take(2)
          : ctx.db
            .query("jurisdictions")
            .withIndex("by_legacyCountryCode_and_status", (q) => q.eq("legacyCountryCode", code).eq("status", args.status!))
            .take(2),
      ]);
      const rows = [...new Map(
        [...codeRows, ...legacyCodeRows]
          .filter((row) => args.status === undefined || row.status === args.status)
          .map((row) => [row._id, row]),
      ).values()];
      return {
        isDone: true,
        continueCursor: "",
        page: rows
          .slice(0, args.paginationOpts.numItems)
          .map(projectPickerJurisdiction),
      };
    }
    if (args.paginationOpts.cursor?.startsWith(LEGACY_PAGE_CURSOR_PREFIX)) {
      const rows = await ctx.db
        .query("jurisdictions")
        .withIndex("by_code", (q) => q.gte("code", "AA").lte("code", "ZZ"))
        .take(MAX_LEGACY_JURISDICTIONS + 1);
      return legacyJurisdictionPage(rows, args.status, args.paginationOpts);
    }
    const result = args.status === undefined
      ? await ctx.db.query("jurisdictions").withIndex("by_code").paginate(args.paginationOpts)
      : await ctx.db
        .query("jurisdictions")
        .withIndex("by_status_and_code", (q) => q.eq("status", args.status!))
        .paginate(args.paginationOpts);
    return { ...result, page: result.page.map(projectPickerJurisdiction) };
  },
});

export const createJurisdiction = mutation({
  args: {
    code: v.string(),
    name: v.string(),
    slug: v.string(),
    isDefault: v.boolean(),
    reason: v.string(),
  },
  returns: v.id("jurisdictions"),
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    const reason = validateAuditReason(args.reason);
    return await createLegacyJurisdictionForActor(ctx, actor, args, reason);
  },
});

export const updateJurisdiction = mutation({
  args: {
    id: v.id("jurisdictions"),
    name: v.string(),
    slug: v.string(),
    isDefault: v.boolean(),
    reason: v.string(),
  },
  returns: jurisdictionDocValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    const reason = validateAuditReason(args.reason);
    const row = await updateLegacyJurisdictionForActor(ctx, actor, args, reason);
    return projectLegacyJurisdiction(row);
  },
});

export const enableJurisdiction = mutation({
  args: { id: v.id("jurisdictions"), reason: v.string() },
  returns: jurisdictionDocValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    const reason = validateAuditReason(args.reason);
    const row = await enableJurisdictionForActor(ctx, actor, args.id, reason);
    return projectLegacyJurisdiction(row);
  },
});

export const archiveJurisdiction = mutation({
  args: { id: v.id("jurisdictions"), reason: v.string() },
  returns: jurisdictionDocValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "jurisdiction", "write");
    const reason = validateAuditReason(args.reason);
    const row = await archiveJurisdictionForActor(ctx, actor, args.id, reason);
    return projectLegacyJurisdiction(row);
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
    await requireEnabledAdminCatalogRead(ctx, "resource");
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
    await requireEnabledAdminCatalogRead(ctx, "resource");
    const resource = await ctx.db.get("legalResources", args.id);
    if (!resource) throw new ConvexError("RESOURCE_NOT_FOUND");
    const jurisdiction = await ctx.db.get("jurisdictions", resource.jurisdictionId);
    if (!jurisdiction) throw new ConvexError("JURISDICTION_NOT_FOUND");
    return {
      ...resource,
      jurisdiction: {
        ...(jurisdiction.code === undefined ? {} : { code: jurisdiction.code }),
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
    await assertNoActiveGeminiStoreTeardown(ctx, args.jurisdictionId);
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

async function requireResourceLifecycleIdle(
  ctx: MutationCtx,
  resourceId: Id<"legalResources">,
) {
  const lock = await ctx.db
    .query("documentLifecycleLocks")
    .withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId))
    .first();
  if (lock) throw new ConvexError("DOCUMENT_LIFECYCLE_BUSY");
}

export const archiveResource = mutation({
  args: { id: v.id("legalResources"), reason: v.string() },
  returns: resourceDocValidator,
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "resource", "write");
    const reason = validateAuditReason(args.reason);
    const row = await ctx.db.get("legalResources", args.id);
    if (!row) throw new ConvexError("RESOURCE_NOT_FOUND");
    if (row.status === "archived") throw new ConvexError("INVALID_RESOURCE_TRANSITION");
    if (row.activeVersionId !== undefined) throw new ConvexError("RESOURCE_MUST_BE_UNPUBLISHED");
    await requireResourceLifecycleIdle(ctx, row._id);
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
    if (row.activeVersionId !== undefined) throw new ConvexError("RESOURCE_MUST_BE_UNPUBLISHED");
    await requireResourceLifecycleIdle(ctx, row._id);
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
    const result = await ctx.db
      .query("documentVersions")
      .withIndex("by_resourceId_and_versionNumber", (q) => q.eq("resourceId", args.resourceId))
      .order("desc")
      .paginate(args.paginationOpts);
    return { ...result, page: result.page.map(projectVersion) };
  },
});
