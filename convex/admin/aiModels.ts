import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import {
  AI_MODEL_FEATURES,
  AI_MODEL_FEATURE_INFO,
  normalizeAiModelId,
  resolveAiModel,
} from "../../shared/ai-models";
import { aiModelFeatureValidator } from "../lib/aiModels";
import { writeAudit } from "./audit";
import { requireEnabledAdminPermission } from "./featureFlags";

const READ: [string, string] = ["operations", "read"];
const WRITE: [string, string] = ["operations", "write"];
const REASON = "AI model settings";

const settingValidator = v.object({
  feature: aiModelFeatureValidator,
  /** Admin-set model, if any. */
  model: v.union(v.string(), v.null()),
  /** What Convex functions resolve to now. Next.js routes read their own environment for the fallback. */
  convexEffectiveModel: v.string(),
  updatedAt: v.union(v.number(), v.null()),
  updatedBy: v.union(v.string(), v.null()),
});

export const list = query({
  args: {},
  returns: v.array(settingValidator),
  handler: async (ctx) => {
    await requireEnabledAdminPermission(ctx, ...READ);
    const rows = await ctx.db.query("aiModelSettings").take(AI_MODEL_FEATURES.length * 2);
    return AI_MODEL_FEATURES.map((feature) => {
      const row = rows.find((candidate) => candidate.feature === feature);
      return {
        feature,
        model: row?.model ?? null,
        convexEffectiveModel: resolveAiModel(feature, row ? { [feature]: row.model } : null, process.env),
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      };
    });
  },
});

/** Sets a feature's model, or clears it (model null) to fall back to environment and code defaults. */
export const set = mutation({
  args: { feature: aiModelFeatureValidator, model: v.union(v.string(), v.null()) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, ...WRITE);
    const model = args.model === null ? null : normalizeAiModelId(args.feature, args.model);
    if (args.model !== null && model === null) {
      throw new ConvexError(`"${args.model.trim().slice(0, 40)}" is not a valid model name. Use letters, numbers, dots, dashes and slashes, such as ${AI_MODEL_FEATURE_INFO[args.feature].defaultModel}.`);
    }
    const existing = await ctx.db
      .query("aiModelSettings")
      .withIndex("by_feature", (q) => q.eq("feature", args.feature))
      .unique();
    if ((existing?.model ?? null) === model) return model;
    const now = Date.now();
    if (model === null) {
      if (existing) await ctx.db.delete(existing._id);
    } else if (existing) {
      await ctx.db.patch(existing._id, { model, updatedAt: now, updatedBy: actor.userId });
    } else {
      await ctx.db.insert("aiModelSettings", { feature: args.feature, model, updatedAt: now, updatedBy: actor.userId });
    }
    await writeAudit(ctx, {
      actorId: actor.userId,
      actorRoles: actor.roles,
      action: model === null ? "ai_model.reset" : "ai_model.changed",
      targetType: "aiModelSetting",
      targetId: args.feature,
      reason: REASON,
      beforeSummary: JSON.stringify({ model: existing?.model ?? "default" }),
      afterSummary: JSON.stringify({ model: model ?? "default" }),
      outcome: "success",
    });
    return model;
  },
});
