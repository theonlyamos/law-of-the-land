import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";

const publicJurisdictionValidator = v.union(
  v.null(),
  v.object({
    code: v.string(),
    name: v.string(),
    slug: v.string(),
    enabled: v.literal(true),
    isDefault: v.boolean(),
    productionBucketId: v.string(),
  }),
);

function normalizeCode(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new ConvexError("INVALID_JURISDICTION_CODE");
  }
  return normalized;
}

/** Returns only configuration that is safe and ready for public retrieval. */
export const getPublicByCode = query({
  args: { code: v.string() },
  returns: publicJurisdictionValidator,
  handler: async (ctx, args) => {
    const code = normalizeCode(args.code);
    const rows = await ctx.db
      .query("jurisdictions")
      .withIndex("by_code", (q) => q.eq("code", code))
      .take(2);
    if (
      rows.length !== 1 ||
      rows[0].status !== "enabled" ||
      !rows[0].productionBucketId
    ) {
      return null;
    }
    const jurisdiction = rows[0];
    const productionBucketId = jurisdiction.productionBucketId;
    if (!productionBucketId) return null;
    return {
      code: jurisdiction.code,
      name: jurisdiction.name,
      slug: jurisdiction.slug,
      enabled: true as const,
      isDefault: jurisdiction.isDefault,
      productionBucketId,
    };
  },
});
