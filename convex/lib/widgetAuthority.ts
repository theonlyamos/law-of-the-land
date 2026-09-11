import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { readyStoreName, type ChatResearchStore } from "../jurisdictions";
import { normalizeWidgetOrigin } from "./widgetContracts";

export async function bumpContentRevision(ctx: MutationCtx, jurisdictionId: Id<"jurisdictions">) {
  const row = await ctx.db.get(jurisdictionId);
  if (row?.kind === "organizational" || row?.kind === "geographic") await ctx.db.patch(row._id, { contentRevision: (row.contentRevision ?? 0) + 1 });
}
export async function bumpWidgetAccessVersion(ctx: MutationCtx, jurisdictionId: Id<"jurisdictions">) {
  const widget = await ctx.db.query("jurisdictionWidgets").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", jurisdictionId)).unique();
  if (widget) await ctx.db.patch(widget._id, { accessVersion: widget.accessVersion + 1 });
}
export function widgetEnvironment(): "production" | "test" {
  return process.env.NODE_ENV === "test" ? "test" : "production";
}
export function widgetParentAllowed(origins: readonly string[], parentOrigin: string): boolean {
  let origin: string;
  try { origin = normalizeWidgetOrigin(parentOrigin, widgetEnvironment()); } catch { return false; }
  const appUrl = process.env.SITE_URL;
  let appOrigin: string | undefined;
  try { if (appUrl) appOrigin = normalizeWidgetOrigin(new URL(appUrl).origin, widgetEnvironment()); } catch { /* Unconfigured preview fails closed. */ }
  return origin === parentOrigin && (origins.includes(origin) || origin === appOrigin);
}
export async function resolveWidgetLibrary(ctx: QueryCtx, jurisdictionId: Id<"jurisdictions">) {
  const jurisdiction = await ctx.db.get(jurisdictionId);
  if (!jurisdiction || (jurisdiction.kind !== "geographic" && jurisdiction.kind !== "organizational") || jurisdiction.status !== "enabled" || (jurisdiction.visibility !== "public" && jurisdiction.visibility !== "members")) throw new ConvexError("WIDGET_UNAVAILABLE");
  const [organization, profile, geographic, storeName] = await Promise.all([
    jurisdiction.organizationId ? ctx.db.get(jurisdiction.organizationId) : null,
    ctx.db.query("organizationalJurisdictions").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", jurisdictionId)).unique(),
    ctx.db.query("geographicJurisdictions").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", jurisdictionId)).unique(),
    readyStoreName(ctx, jurisdictionId),
  ]);
  if (!storeName || (jurisdiction.kind === "organizational" ? organization?.status !== "active" || !profile || !!geographic : !geographic || !!profile || !!jurisdiction.organizationId)) throw new ConvexError("WIDGET_UNAVAILABLE");
  const [locks, legacyLocks] = await Promise.all([
    ctx.db.query("documentLifecycleLocks").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", jurisdictionId)).take(1),
    ctx.db.query("documentLifecycleLocks").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", undefined)).take(1),
  ]);
  // Legacy locks have no jurisdiction binding: deny research until they reconcile.
  if (locks.length || legacyLocks.length) throw new ConvexError("WIDGET_UNAVAILABLE");
  for (const status of ["queued", "running", "waiting_provider", "manual_review"] as const) {
    const teardown = await ctx.db.query("integrationJobs").withIndex("by_targetType_and_targetId_and_type_and_status", q => q.eq("targetType", "jurisdictionGeminiStore").eq("targetId", jurisdictionId).eq("type", "gemini_delete_store").eq("status", status)).take(1);
    if (teardown.length) throw new ConvexError("WIDGET_UNAVAILABLE");
  }
  const resources = await ctx.db.query("legalResources").withIndex("by_jurisdictionId_and_activeVersionId", q => q.eq("jurisdictionId", jurisdictionId).gt("activeVersionId", undefined)).take(1);
  const resource = resources[0];
  const version = resource?.activeVersionId ? await ctx.db.get(resource.activeVersionId) : null;
  if (!resource || resource.status !== "active" || version?.status !== "published" || version.resourceId !== resource._id || !version.geminiDocumentName?.startsWith(`${storeName}/documents/`)) throw new ConvexError("WIDGET_UNAVAILABLE");
  const store: ChatResearchStore = { jurisdictionId, name: jurisdiction.name, kind: jurisdiction.kind, relation: "selected", storeName };
  return { organizationId: organization?._id, jurisdictionId, contentRevision: jurisdiction.contentRevision ?? 0, store };
}

// Retain organization keys for existing records; geographical widgets use their jurisdiction.
export type WidgetQuotaScope = { organizationId: Id<"organizations">; jurisdictionId?: never } | { organizationId?: never; jurisdictionId: Id<"jurisdictions"> };
export function widgetQuotaScope(owner: { organizationId?: Id<"organizations">; jurisdictionId?: Id<"jurisdictions"> }): WidgetQuotaScope {
  if (owner.organizationId && !owner.jurisdictionId) return { organizationId: owner.organizationId };
  if (owner.jurisdictionId && !owner.organizationId) return { jurisdictionId: owner.jurisdictionId };
  throw new ConvexError("WIDGET_UNAVAILABLE");
}
export function widgetAllowance(ctx: QueryCtx, scope: WidgetQuotaScope) {
  const rows = ctx.db.query("organizationWidgetAllowances");
  return scope.organizationId !== undefined ? rows.withIndex("by_organizationId", q => q.eq("organizationId", scope.organizationId)).unique()
    : rows.withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", scope.jurisdictionId)).unique();
}
export function widgetUsage(ctx: QueryCtx, scope: WidgetQuotaScope, bucket: string) {
  const rows = ctx.db.query("widgetUsageBuckets");
  return scope.organizationId !== undefined ? rows.withIndex("by_organizationId_and_bucket", q => q.eq("organizationId", scope.organizationId).eq("bucket", bucket)).unique()
    : rows.withIndex("by_jurisdictionId_and_bucket", q => q.eq("jurisdictionId", scope.jurisdictionId).eq("bucket", bucket)).unique();
}
export async function resolveWidgetAuthority(ctx: QueryCtx, publicId: string, parentOrigin: string) {
  const widget = await ctx.db.query("jurisdictionWidgets").withIndex("by_publicId", q => q.eq("publicId", publicId)).unique();
  if (!widget?.enabled || !widgetParentAllowed(widget.allowedOrigins, parentOrigin)) throw new ConvexError("WIDGET_UNAVAILABLE");
  const library = await resolveWidgetLibrary(ctx, widget.jurisdictionId);
  if (library.organizationId !== widget.organizationId) throw new ConvexError("WIDGET_UNAVAILABLE");
  return { ...library, accessVersion: widget.accessVersion, widget };
}
