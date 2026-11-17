import { v } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import {
  AI_MODEL_FEATURES,
  resolveAiModel,
  type AiModelFeature,
  type AiModelOverrides,
} from "../../shared/ai-models";

export const aiModelFeatureValidator = v.union(
  v.literal("chat"),
  v.literal("transcription"),
  v.literal("document_review"),
  v.literal("document_draft"),
  v.literal("profile_memory"),
  v.literal("source_verification"),
  v.literal("intent_routing"),
  v.literal("embedding"),
);

/** Admin-set models only. Features left unset fall back to environment and code defaults. */
export async function readAiModelOverrides(ctx: QueryCtx): Promise<AiModelOverrides> {
  const rows = await ctx.db.query("aiModelSettings").take(AI_MODEL_FEATURES.length * 2);
  const overrides: AiModelOverrides = {};
  for (const row of rows) overrides[row.feature] = row.model;
  return overrides;
}

/** The model a Convex function should call now, reading Convex environment variables as the fallback. */
export async function readAiModel(ctx: QueryCtx, feature: AiModelFeature): Promise<string> {
  const row = await ctx.db
    .query("aiModelSettings")
    .withIndex("by_feature", (q) => q.eq("feature", feature))
    .unique();
  return resolveAiModel(feature, row ? { [feature]: row.model } : null, process.env);
}
