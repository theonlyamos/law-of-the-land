import { v, ConvexError } from "convex/values";
import { query, mutation, type QueryCtx } from "./_generated/server";
import { requireOrganizationAccess } from "./lib/organizationAccess";
import { normalizeWidgetSettings, widgetSettingsValidator, type WidgetSettings, type WidgetConfig } from "./lib/widgetContracts";
import { resolveWidgetAuthority, resolveWidgetLibrary, widgetEnvironment, widgetQuotaScope, widgetAllowance, widgetUsage } from "./lib/widgetAuthority";
import { writeAudit, validateAuditReason } from "./admin/audit";
import { requireEnabledAdminPermission, requireEnabledAdminCatalogRead } from "./admin/featureFlags";

import type { Id } from "./_generated/dataModel";
import { hasRolePermission } from "./lib/adminPermissions";

const targetArgs = { organizationId: v.optional(v.id("organizations")), jurisdictionId: v.optional(v.id("jurisdictions")) };
async function settingsAccess(ctx: QueryCtx, target: { organizationId?: Id<"organizations">; jurisdictionId?: Id<"jurisdictions"> }, manage: boolean) {
  const scope = widgetQuotaScope(target);
  if (scope.organizationId !== undefined) {
    const actor = await requireOrganizationAccess(ctx, scope.organizationId, manage ? "manage" : "read");
    const jurisdiction = await ctx.db.query("jurisdictions").withIndex("by_organizationId", q => q.eq("organizationId", scope.organizationId)).unique();
    if ((jurisdiction && jurisdiction.kind !== "organizational") || (!jurisdiction && manage)) throw new ConvexError("ORGANIZATION_JURISDICTION_REQUIRED");
    return { scope, jurisdiction, canManage: actor.organizationRole === "manager", actor: { actorId: actor.userId, actorRoles: [], organizationId: actor.organizationId, organizationRole: actor.organizationRole } };
  }
  const actor = manage ? await requireEnabledAdminPermission(ctx, "jurisdiction", "write") : await requireEnabledAdminCatalogRead(ctx, "jurisdiction");
  const jurisdiction = await ctx.db.get(scope.jurisdictionId);
  if (jurisdiction?.kind !== "geographic" || jurisdiction.organizationId) throw new ConvexError("GEOGRAPHIC_JURISDICTION_REQUIRED");
  return { scope, jurisdiction, canManage: !actor.impersonatedBy && hasRolePermission(actor.roles, "jurisdiction", "write"), actor: { actorId: actor.userId, actorRoles: actor.roles } };
}
function settingsProjection(row: WidgetSettings): WidgetSettings {
  return { enabled: row.enabled, allowedOrigins: row.allowedOrigins, title: row.title, welcomeMessage: row.welcomeMessage, suggestedQuestions: row.suggestedQuestions, accent: row.accent, side: row.side };
}
export const getSettings = query({ args: targetArgs, handler: async (ctx, args) => {
  const { jurisdiction, scope, canManage } = await settingsAccess(ctx, args, false);
  const widget = jurisdiction ? await ctx.db.query("jurisdictionWidgets").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", jurisdiction._id)).unique() : null;
  const allowance = await widgetAllowance(ctx, scope);
  let ready = false;
  if (jurisdiction) { try { await resolveWidgetLibrary(ctx, jurisdiction._id); ready = true; } catch { /* Display readiness without provider details. */ } }
  const now = Date.now(), iso = new Date(now).toISOString();
  const [day, month] = await Promise.all([iso.slice(0, 10), iso.slice(0, 7)].map(bucket => widgetUsage(ctx, scope, bucket)));
  const settings: WidgetSettings = widget ? settingsProjection(widget) : { enabled: false, allowedOrigins: [], title: `Ask ${jurisdiction?.name ?? "our organization"}`.slice(0, 80), welcomeMessage: "Ask a question about our published documents.", suggestedQuestions: [], accent: "#8d6a35", side: "right" };
  return { publicId: widget?.publicId ?? null, jurisdictionName: jurisdiction?.name ?? "Organization", settings, canManage,
    readiness: ready ? "Published documents available" : !jurisdiction ? "Create an organization jurisdiction first." : jurisdiction.visibility !== "public" ? "Make your jurisdiction public before enabling website chat." : "Publish a document and wait for indexing to finish.", ready,
    dailyLimit: allowance?.dailyLimit ?? 0, monthlyLimit: allowance?.monthlyLimit ?? 0, platformDailyLimit: allowance?.platformDailyLimit ?? 0, platformMonthlyLimit: allowance?.platformMonthlyLimit ?? 0,
    usage: { day: day?.count ?? 0, month: month?.count ?? 0, dayReset: Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + 86400000, monthReset: Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1) } };
} });
export const saveSettings = mutation({ args: { ...targetArgs, settings: widgetSettingsValidator, dailyLimit: v.number(), monthlyLimit: v.number() }, returns: v.string(), handler: async (ctx, args) => {
  const { actor, jurisdiction, scope } = await settingsAccess(ctx, args, true);
  if (!jurisdiction) throw new ConvexError("ORGANIZATION_JURISDICTION_REQUIRED");
  const settings = normalizeWidgetSettings(args.settings, widgetEnvironment());
  const allowance = await widgetAllowance(ctx, scope);
  if (![args.dailyLimit, args.monthlyLimit].every(n => Number.isSafeInteger(n) && n >= 0) || args.dailyLimit > (allowance?.platformDailyLimit ?? 0) || args.monthlyLimit > (allowance?.platformMonthlyLimit ?? 0)) throw new ConvexError("WIDGET_ALLOWANCE_INVALID");
  if (settings.enabled) {
    await resolveWidgetLibrary(ctx, jurisdiction._id);
    if (!args.dailyLimit || !args.monthlyLimit) throw new ConvexError("WIDGET_ALLOWANCE_REQUIRED");
  }
  if (allowance) await ctx.db.patch(allowance._id, { dailyLimit: args.dailyLimit, monthlyLimit: args.monthlyLimit, updatedAt: Date.now(), updatedBy: actor.actorId });
  const old = await ctx.db.query("jurisdictionWidgets").withIndex("by_jurisdictionId", q => q.eq("jurisdictionId", jurisdiction._id)).unique();
  const publicId = old?.publicId ?? crypto.randomUUID();
  if (old && old.organizationId !== scope.organizationId) throw new ConvexError("ORGANIZATION_ACCESS_DENIED");
  const accessChanged = old && (old.enabled !== settings.enabled || JSON.stringify([...old.allowedOrigins].sort()) !== JSON.stringify([...settings.allowedOrigins].sort()));
  const record = { ...settings, organizationId: scope.organizationId, jurisdictionId: jurisdiction._id, publicId, accessVersion: (old?.accessVersion ?? 0) + (accessChanged ? 1 : 0), updatedAt: Date.now(), updatedBy: actor.actorId };
  if (old) await ctx.db.patch(old._id, record);
  else await ctx.db.insert("jurisdictionWidgets", { ...record, createdAt: Date.now() });
  await writeAudit(ctx, { ...actor, action: "widget.settings_saved", targetType: "jurisdiction", targetId: jurisdiction._id, outcome: "success" });
  return publicId;
} });
export const getPublicConfig = query({ args: { publicId: v.string(), parentOrigin: v.string() }, handler: async (ctx, args): Promise<WidgetConfig | null> => {
  if (args.publicId.length > 100 || args.parentOrigin.length > 500) return null;
  try {
    const authority = await resolveWidgetAuthority(ctx, args.publicId, args.parentOrigin);
    return { ...settingsProjection(authority.widget), publicId: authority.widget.publicId, jurisdictionName: authority.store.name };
  } catch { return null; }
} });
export const setWidgetAllowance = mutation({ args: { ...targetArgs, platformDailyLimit: v.number(), platformMonthlyLimit: v.number(), maxConcurrent: v.number(), reason: v.string() }, returns: v.null(), handler: async (ctx, args) => {
  const scope = widgetQuotaScope(args);
  const actor = await requireEnabledAdminPermission(ctx, scope.organizationId !== undefined ? "organization" : "jurisdiction", "write");
  const reason = validateAuditReason(args.reason);
  if (![args.platformDailyLimit, args.platformMonthlyLimit].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000) || !Number.isInteger(args.maxConcurrent) || args.maxConcurrent < 1 || args.maxConcurrent > 10) throw new ConvexError("WIDGET_ALLOWANCE_INVALID");
  if (scope.organizationId !== undefined) { if (!(await ctx.db.get(scope.organizationId))) throw new ConvexError("ORGANIZATION_NOT_FOUND"); }
  else { const row = await ctx.db.get(scope.jurisdictionId); if (row?.kind !== "geographic" || row.organizationId) throw new ConvexError("GEOGRAPHIC_JURISDICTION_REQUIRED"); }
  const old = await widgetAllowance(ctx, scope);
  const record = { ...scope, platformDailyLimit: args.platformDailyLimit, platformMonthlyLimit: args.platformMonthlyLimit, maxConcurrent: args.maxConcurrent, dailyLimit: Math.min(old?.dailyLimit ?? args.platformDailyLimit, args.platformDailyLimit), monthlyLimit: Math.min(old?.monthlyLimit ?? args.platformMonthlyLimit, args.platformMonthlyLimit), updatedAt: Date.now(), updatedBy: actor.userId };
  if (old) await ctx.db.patch(old._id, record); else await ctx.db.insert("organizationWidgetAllowances", record);
  await writeAudit(ctx, { actorId: actor.userId, actorRoles: actor.roles, action: "widget.allowance_set", targetType: scope.organizationId !== undefined ? "organization" : "jurisdiction", targetId: scope.organizationId ?? scope.jurisdictionId, reason, outcome: "success" });
  return null;
} });
