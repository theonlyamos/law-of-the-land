import { v } from "convex/values";
import { internalQuery, query } from "./_generated/server";
import { aiModelFeatureValidator, readAiModel, readAiModelOverrides } from "./lib/aiModels";

const overridesValidator = v.object({
  chat: v.optional(v.string()),
  transcription: v.optional(v.string()),
  document_review: v.optional(v.string()),
  document_draft: v.optional(v.string()),
  profile_memory: v.optional(v.string()),
  source_verification: v.optional(v.string()),
  intent_routing: v.optional(v.string()),
  embedding: v.optional(v.string()),
});

/**
 * Admin-chosen model names for the Next.js routes, which add their own
 * environment fallbacks. Public because guest and widget routes call it
 * without a user; it returns model names only.
 */
export const overrides = query({
  args: {},
  returns: overridesValidator,
  handler: async (ctx) => await readAiModelOverrides(ctx),
});

/** The model a Convex action should use for one feature right now. */
export const resolve = internalQuery({
  args: { feature: aiModelFeatureValidator },
  returns: v.string(),
  handler: async (ctx, args) => await readAiModel(ctx, args.feature),
});
