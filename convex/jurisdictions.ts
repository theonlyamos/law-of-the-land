import { ConvexError, v } from "convex/values";
import { internalQuery, query } from "./_generated/server";
import { isLegacyCountryCode } from "./lib/jurisdictionDomain";
import { isPublicJurisdictionEligible } from "./lib/jurisdictionEligibility";

const searchJurisdictionValidator = v.union(
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

const publicJurisdictionListItemValidator = v.object({
  code: v.string(),
  name: v.string(),
  slug: v.string(),
  isDefault: v.boolean(),
});

// Admin validation currently accepts any two-letter code (26 × 26).
const MAX_PUBLIC_JURISDICTIONS = 26 * 26;

function normalizeCode(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new ConvexError("INVALID_JURISDICTION_CODE");
  }
  return normalized;
}

/** Returns provider configuration only to protected server-side callers. */
export const getPublicByCode = internalQuery({
  args: { code: v.string() },
  returns: searchJurisdictionValidator,
  handler: async (ctx, args) => {
    const code = normalizeCode(args.code);
    const rows = await ctx.db
      .query("jurisdictions")
      .withIndex("by_code_and_status", (q) =>
        q.eq("code", code).eq("status", "enabled"),
      )
      .take(2);
    if (
      rows.length !== 1 ||
      !isLegacyCountryCode(rows[0].code) ||
      rows[0].code !== code ||
      !isPublicJurisdictionEligible(rows[0])
    ) {
      return null;
    }
    const jurisdiction = rows[0];
    const productionBucketId = jurisdiction.productionBucketId;
    if (!productionBucketId) return null;
    return {
      code,
      name: jurisdiction.name,
      slug: jurisdiction.slug,
      enabled: true as const,
      isDefault: jurisdiction.isDefault,
      productionBucketId,
    };
  },
});

/** Lists the complete enabled ISO catalog used by public jurisdiction selectors. */
export const listPublicEnabled = query({
  args: {},
  returns: v.array(publicJurisdictionListItemValidator),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("jurisdictions")
      .withIndex("by_status_and_code", (q) =>
        q.eq("status", "enabled").gte("code", "AA").lte("code", "ZZ"),
      )
      .take(MAX_PUBLIC_JURISDICTIONS + 1);

    const legacyRows = rows.filter(
      (row): row is typeof row & { code: string } => isLegacyCountryCode(row.code),
    );
    // More legacy rows than possible two-letter codes proves corruption.
    // Code-less unified rows are intentionally invisible to this flag-off path.
    if (legacyRows.length > MAX_PUBLIC_JURISDICTIONS) return [];
    const enabledRowsByCode = new Map<string, number>();
    for (const row of legacyRows) {
      enabledRowsByCode.set(row.code, (enabledRowsByCode.get(row.code) ?? 0) + 1);
    }

    return legacyRows
      .filter(
        (row) =>
          enabledRowsByCode.get(row.code) === 1 &&
          isPublicJurisdictionEligible(row),
      )
      .map(({ code, name, slug, isDefault }) => ({ code, name, slug, isDefault }))
      .sort((left, right) =>
        Number(right.isDefault) - Number(left.isDefault) ||
        left.name.localeCompare(right.name) ||
        left.code.localeCompare(right.code),
      );
  },
});
