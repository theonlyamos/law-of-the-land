import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query } from "./_generated/server";
import { organizationScopeModeValidator } from "./lib/jurisdictionDomain";
import {
  requireOrganizationAccess,
  requireOrganizationJurisdiction,
} from "./lib/organizationAccess";
import {
  currentOrganizationJurisdictions,
  discoveryText,
  finishOrganizationOperation,
  MAX_ORGANIZATION_JURISDICTIONS,
  organizationName,
  organizationOperation,
  organizationRate,
  validatePageSize,
} from "./lib/organizationManagement";
import {
  archiveJurisdictionForActor,
  assertOrganizationalScope,
  createOrganizationalJurisdictionForActor,
  enableJurisdictionForActor,
  resolveScopeProfiles,
} from "./admin/jurisdictions";
import { queueGeminiStoreProvision, retryJobForActor } from "./admin/jobs";
import { consumeStepUp } from "./admin/publication";
import { validateAuditReason, writeAudit } from "./admin/audit";
import {
  bumpContentRevision,
  bumpWidgetAccessVersion,
} from "./lib/widgetAuthority";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

const targetArgs = {
  organizationId: v.id("organizations"),
  jurisdictionId: v.id("jurisdictions"),
};
const scopeArgs = {
  scopeMode: organizationScopeModeValidator,
  geographicJurisdictionIds: v.array(v.id("jurisdictions")),
};
const lifecycleArgs = { ...targetArgs, reason: v.string() };
function project(row: Doc<"jurisdictions">) {
  return {
    id: row._id,
    name: row.name,
    slug: row.slug,
    organizationId: row.organizationId!,
    status: row.status,
    visibility: row.visibility ?? "members",
    libraryState:
      row.providerSyncState === "synced" && !!row.geminiFileSearchStoreName
        ? ("ready" as const)
        : row.providerSyncState === "pending"
          ? ("setting_up" as const)
          : ("needs_attention" as const),
  };
}
export const create = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    ...scopeArgs,
    idempotencyKey: v.string(),
  },
  returns: v.id("jurisdictions"),
  handler: async (ctx, args) => {
    const actor = await requireOrganizationAccess(
      ctx,
      args.organizationId,
      "manage",
    );
    const name = organizationName(args.name),
      action = "organization.jurisdiction_create";
    const receipt = await organizationOperation(
      ctx,
      actor.userId,
      action,
      args.idempotencyKey,
      {
        organizationId: args.organizationId,
        name,
        scopeMode: args.scopeMode,
        geographicJurisdictionIds: [...args.geographicJurisdictionIds].sort(),
      },
    );
    if (receipt.old) return receipt.old.targetId as Id<"jurisdictions">;
    await organizationRate(
      ctx,
      "organization_jurisdiction_create",
      actor.userId,
      20,
    );
    const id = await createOrganizationalJurisdictionForActor(
      ctx,
      { ...actor, roles: [] },
      {
        ...args,
        name,
        visibility: "members",
        reason: "Create organization jurisdiction",
      },
    );
    await finishOrganizationOperation(
      ctx,
      actor.userId,
      action,
      args.idempotencyKey,
      receipt.fingerprint,
      id,
    );
    return id;
  },
});
export const list = query({
  args: {
    organizationId: v.id("organizations"),
    status: v.union(v.literal("current"), v.literal("archived")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireOrganizationAccess(ctx, args.organizationId, "read");
    validatePageSize(args.paginationOpts.numItems);
    const rows = ctx.db
      .query("jurisdictions")
      .withIndex("by_organizationId_and_status_and_name", (q) =>
        args.status === "archived"
          ? q.eq("organizationId", args.organizationId).eq("status", "archived")
          : q.eq("organizationId", args.organizationId).gte("status", "draft"),
      );
    const result = await rows.paginate(args.paginationOpts);
    return {
      ...result,
      page: await Promise.all(
        result.page.map(async (row) => ({
          ...project(row),
          widgetEnabled: !!(
            await ctx.db
              .query("jurisdictionWidgets")
              .withIndex("by_jurisdictionId", (q) =>
                q.eq("jurisdictionId", row._id),
              )
              .unique()
          )?.enabled,
        })),
      ),
    };
  },
});
export const get = query({
  args: targetArgs,
  handler: async (ctx, args) => {
    const { actor, jurisdiction } = await requireOrganizationJurisdiction(
      ctx,
      args.organizationId,
      args.jurisdictionId,
      "read",
    );
    const profile = await ctx.db
      .query("organizationalJurisdictions")
      .withIndex("by_jurisdictionId", (q) =>
        q.eq("jurisdictionId", jurisdiction._id),
      )
      .unique();
    if (!profile) throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
    const links = await ctx.db
      .query("organizationGeographicScopes")
      .withIndex(
        "by_organizationalJurisdictionId_and_geographicJurisdictionId",
        (q) => q.eq("organizationalJurisdictionId", profile._id),
      )
      .take(5);
    const geographicJurisdictions = await Promise.all(
      links.map(async (link) => {
        const geo = await ctx.db.get(link.geographicJurisdictionId);
        const row = geo ? await ctx.db.get(geo.jurisdictionId) : null;
        return row ? { id: row._id, name: row.name } : null;
      }),
    );
    return {
      jurisdiction: project(jurisdiction),
      scopeMode: profile.scopeMode,
      geographicJurisdictions: geographicJurisdictions.filter(
        (row) => row !== null,
      ),
      canManage: actor.canManage,
      canReview: actor.canReview,
      isOwner: actor.isOwner,
    };
  },
});
export const update = mutation({
  args: { ...targetArgs, name: v.string(), ...scopeArgs, reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { actor, jurisdiction } = await requireOrganizationJurisdiction(
      ctx,
      args.organizationId,
      args.jurisdictionId,
      "manage",
    );
    const name = organizationName(args.name),
      reason = validateAuditReason(args.reason);
    const siblings = await currentOrganizationJurisdictions(
      ctx,
      args.organizationId,
    );
    if (
      siblings.some(
        (row) =>
          row._id !== jurisdiction._id &&
          row.name.normalize("NFKC").toLowerCase() === name.toLowerCase(),
      )
    )
      throw new ConvexError("ORGANIZATION_JURISDICTION_NAME_EXISTS");
    const organization = await ctx.db.get(args.organizationId);
    const profile = await ctx.db
      .query("organizationalJurisdictions")
      .withIndex("by_jurisdictionId", (q) =>
        q.eq("jurisdictionId", jurisdiction._id),
      )
      .unique();
    if (!profile) throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
    const geographies = await resolveScopeProfiles(
      ctx,
      args.scopeMode,
      args.geographicJurisdictionIds,
    );
    const links = await ctx.db
      .query("organizationGeographicScopes")
      .withIndex(
        "by_organizationalJurisdictionId_and_geographicJurisdictionId",
        (q) => q.eq("organizationalJurisdictionId", profile._id),
      )
      .take(5);
    if (links.length > 4) throw new ConvexError("GEOGRAPHIC_SCOPE_INVALID");
    for (const link of links) await ctx.db.delete(link._id);
    for (const geo of geographies)
      await ctx.db.insert("organizationGeographicScopes", {
        organizationalJurisdictionId: profile._id,
        geographicJurisdictionId: geo._id,
        createdAt: Date.now(),
      });
    await ctx.db.patch(profile._id, {
      scopeMode: args.scopeMode,
      updatedAt: Date.now(),
    });
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
      organizationId: args.organizationId,
      organizationRole: actor.organizationRole,
      action: "organization.jurisdiction_updated",
      targetType: "jurisdiction",
      targetId: jurisdiction._id,
      reason,
      outcome: "success",
    });
    return null;
  },
});
export const setVisibility = mutation({
  args: {
    ...targetArgs,
    visibility: v.union(v.literal("public"), v.literal("members")),
    confirmation: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { actor, jurisdiction } = await requireOrganizationJurisdiction(
      ctx,
      args.organizationId,
      args.jurisdictionId,
      "manage",
    );
    const action = "organization.visibility";
    const receipt = await organizationOperation(
      ctx,
      actor.userId,
      action,
      args.idempotencyKey,
      {
        jurisdictionId: args.jurisdictionId,
        visibility: args.visibility,
        confirmation: args.confirmation,
      },
    );
    if (receipt.old) return null;
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
    await ctx.db.patch(jurisdiction._id, {
      visibility: args.visibility,
      updatedAt: Date.now(),
      updatedBy: actor.userId,
    });
    await bumpWidgetAccessVersion(ctx, jurisdiction._id);
    await bumpContentRevision(ctx, jurisdiction._id);
    await finishOrganizationOperation(
      ctx,
      actor.userId,
      action,
      args.idempotencyKey,
      receipt.fingerprint,
      jurisdiction._id,
    );
    await writeAudit(ctx, {
      actorId: actor.userId,
      actorRoles: [],
      organizationId: args.organizationId,
      organizationRole: actor.organizationRole,
      action: "organization.visibility_set",
      targetType: "jurisdiction",
      targetId: jurisdiction._id,
      afterSummary: args.visibility,
      outcome: "success",
    });
    return null;
  },
});
async function lifecycle(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    jurisdictionId: Id<"jurisdictions">;
    reason: string;
  },
  operation: "enable" | "archive" | "restore",
) {
  const actor = await requireOrganizationAccess(
    ctx,
    args.organizationId,
    "manage",
  );
  const jurisdiction = await ctx.db.get(args.jurisdictionId);
  if (
    jurisdiction?.organizationId !== args.organizationId ||
    jurisdiction.kind !== "organizational"
  )
    throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
  const reason = validateAuditReason(args.reason);
  if (operation === "enable")
    await enableJurisdictionForActor(
      ctx,
      { ...actor, roles: [] },
      jurisdiction._id,
      reason,
    );
  else if (operation === "archive") {
    await archiveJurisdictionForActor(
      ctx,
      { ...actor, roles: [] },
      jurisdiction._id,
      reason,
    );
    const widget = await ctx.db
      .query("jurisdictionWidgets")
      .withIndex("by_jurisdictionId", (q) =>
        q.eq("jurisdictionId", jurisdiction._id),
      )
      .unique();
    if (widget) await ctx.db.patch(widget._id, { enabled: false });
  } else {
    if (jurisdiction.status !== "archived")
      throw new ConvexError("INVALID_JURISDICTION_TRANSITION");
    const siblings = await currentOrganizationJurisdictions(
      ctx,
      args.organizationId,
    );
    if (siblings.length >= MAX_ORGANIZATION_JURISDICTIONS)
      throw new ConvexError("ORGANIZATION_JURISDICTION_LIMIT");
    if (
      siblings.some(
        (row) =>
          row.name.normalize("NFKC").toLowerCase() ===
          jurisdiction.name.normalize("NFKC").toLowerCase(),
      )
    )
      throw new ConvexError("ORGANIZATION_JURISDICTION_NAME_EXISTS");
    for (const status of [
      "queued",
      "running",
      "waiting_provider",
      "manual_review",
    ] as const) {
      const deletion = await ctx.db
        .query("integrationJobs")
        .withIndex("by_targetType_and_targetId_and_type_and_status", (q) =>
          q
            .eq("targetType", "jurisdictionGeminiStore")
            .eq("targetId", jurisdiction._id)
            .eq("type", "gemini_delete_store")
            .eq("status", status),
        )
        .first();
      if (deletion) throw new ConvexError("GEMINI_STORE_TEARDOWN_IN_PROGRESS");
    }
    await assertOrganizationalScope(ctx, jurisdiction);
    const org = await ctx.db.get(args.organizationId);
    const patch = {
      status: "draft" as const,
      discoveryText: discoveryText(org!.name, jurisdiction.name),
      updatedAt: Date.now(),
      updatedBy: actor.userId,
    };
    await ctx.db.patch(jurisdiction._id, patch);
    const widget = await ctx.db
      .query("jurisdictionWidgets")
      .withIndex("by_jurisdictionId", (q) =>
        q.eq("jurisdictionId", jurisdiction._id),
      )
      .unique();
    if (widget)
      await ctx.db.patch(widget._id, {
        enabled: false,
        accessVersion: widget.accessVersion + 1,
      });
    await bumpContentRevision(ctx, jurisdiction._id);
    if (!jurisdiction.geminiFileSearchStoreName)
      await queueGeminiStoreProvision(
        ctx,
        { ...jurisdiction, ...patch },
        { ...actor, id: actor.userId, roles: [] },
        `restore-${jurisdiction._id}-${jurisdiction.updatedAt}`,
      );
    await writeAudit(ctx, {
      actorId: actor.userId,
      actorRoles: [],
      organizationId: args.organizationId,
      action: "jurisdiction.restored",
      targetType: "jurisdiction",
      targetId: jurisdiction._id,
      reason,
      outcome: "success",
    });
  }
  return null;
}
export const enable = mutation({
  args: lifecycleArgs,
  returns: v.null(),
  handler: (ctx, args) => lifecycle(ctx, args, "enable"),
});
export const archive = mutation({
  args: lifecycleArgs,
  returns: v.null(),
  handler: (ctx, args) => lifecycle(ctx, args, "archive"),
});
export const restore = mutation({
  args: lifecycleArgs,
  returns: v.null(),
  handler: (ctx, args) => lifecycle(ctx, args, "restore"),
});
export const retrySetup = mutation({
  args: { ...targetArgs, idempotencyKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { actor, jurisdiction } = await requireOrganizationJurisdiction(
      ctx,
      args.organizationId,
      args.jurisdictionId,
      "manage",
    );
    const jobs = await ctx.db
      .query("integrationJobs")
      .withIndex("by_targetType_and_targetId_and_type_and_status", (q) =>
        q
          .eq("targetType", "jurisdictionGeminiStore")
          .eq("targetId", jurisdiction._id)
          .eq("type", "gemini_create_store")
          .eq("status", "manual_review"),
      )
      .take(2);
    if (jobs.length !== 1)
      throw new ConvexError("ORGANIZATION_SETUP_REVIEW_REQUIRED");
    await retryJobForActor(
      ctx,
      {
        jobId: jobs[0]._id,
        reason: "Resume organization library setup",
        idempotencyKey: args.idempotencyKey,
      },
      { ...actor, roles: [] },
    );
    return null;
  },
});
export const listGeographicOptions = query({
  args: {
    organizationId: v.id("organizations"),
    query: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireOrganizationAccess(ctx, args.organizationId, "manage");
    validatePageSize(args.paginationOpts.numItems);
    const search = args.query?.trim();
    if (search && search.length > 100) throw new ConvexError("INVALID_SEARCH");
    const result = search
      ? await ctx.db
          .query("jurisdictions")
          .withSearchIndex("search_name", (q) =>
            q
              .search("name", search)
              .eq("kind", "geographic")
              .eq("status", "enabled"),
          )
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("jurisdictions")
          .withIndex("by_kind_and_status_and_name", (q) =>
            q.eq("kind", "geographic").eq("status", "enabled"),
          )
          .paginate(args.paginationOpts);
    await Promise.all(result.page.map(row => resolveScopeProfiles(ctx, "linked_geographies", [row._id])));
    return {
      ...result,
      page: result.page.map((row) => ({ id: row._id, name: row.name })),
    };
  },
});
