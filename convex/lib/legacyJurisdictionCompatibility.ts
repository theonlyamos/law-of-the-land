import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isLegacyCountryCode } from "./jurisdictionDomain";

export type JurisdictionContract = "legacy" | "unified";

type JurisdictionContractRow = {
  jurisdictionContract?: JurisdictionContract;
  jurisdictionId?: Id<"jurisdictions">;
  jurisdictionName?: string;
  jurisdictionKind?: "geographic" | "organizational";
  country?: string;
  jurisdictionCode?: string;
};

export function effectiveJurisdictionContract(
  row: JurisdictionContractRow,
): JurisdictionContract {
  return row.jurisdictionContract ?? (row.jurisdictionId ? "unified" : "legacy");
}

export function hasCoherentJurisdictionContractIdentity(
  row: JurisdictionContractRow,
): boolean {
  const contract = effectiveJurisdictionContract(row);
  if (row.jurisdictionContract === undefined && row.jurisdictionId === undefined) {
    return true;
  }
  if (!row.jurisdictionId || !row.jurisdictionName?.trim() ||
    (row.jurisdictionKind !== "geographic" && row.jurisdictionKind !== "organizational")) {
    return false;
  }
  const legacyCode = row.country ?? row.jurisdictionCode;
  return contract === "unified" ||
    (row.jurisdictionKind === "geographic" &&
      legacyCode !== undefined && isLegacyCountryCode(legacyCode));
}

type CompatibilityCtx = Pick<QueryCtx, "db">;

export type LegacyJurisdictionSnapshot = {
  jurisdictionId: Id<"jurisdictions">;
  jurisdictionName: string;
  jurisdictionKind: "geographic";
  country: string;
};

async function validateLegacyGeographicJurisdiction(
  ctx: CompatibilityCtx,
  row: Doc<"jurisdictions">,
  country: string,
): Promise<LegacyJurisdictionSnapshot | null> {
  const [geographicProfiles, organizationalProfiles] = await Promise.all([
    ctx.db.query("geographicJurisdictions")
      .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", row._id)).take(2),
    ctx.db.query("organizationalJurisdictions")
      .withIndex("by_jurisdictionId", (q) => q.eq("jurisdictionId", row._id)).take(1),
  ]);
  if (row.organizationId || organizationalProfiles.length !== 0) return null;
  if (row.code !== undefined && row.code !== country) return null;

  const typed = row.kind !== undefined || geographicProfiles.length !== 0;
  if (typed) {
    const profile = geographicProfiles[0];
    if (row.kind !== "geographic" || row.visibility !== "public" ||
      row.legacyCountryCode !== country || geographicProfiles.length !== 1 ||
      !profile || profile.level !== "country" || profile.countryCode !== country ||
      profile.parentJurisdictionId !== undefined) return null;
  } else if (country !== "GH" || row.code !== "GH" || row.status !== "enabled" ||
    row.isDefault !== true ||
    row.providerSyncState !== "synced" ||
    (row.legacyCountryCode !== undefined && row.legacyCountryCode !== "GH") ||
    (row.visibility !== undefined && row.visibility !== "public")) {
    return null;
  }

  return {
    jurisdictionId: row._id,
    jurisdictionName: row.name,
    jurisdictionKind: "geographic",
    country,
  };
}

export async function resolveLegacyJurisdictionSnapshot(
  ctx: CompatibilityCtx,
  suppliedCountry?: string,
): Promise<LegacyJurisdictionSnapshot | null> {
  if (suppliedCountry !== undefined) {
    const country = suppliedCountry.trim().toUpperCase();
    if (!isLegacyCountryCode(country)) return null;
    const [canonical, codeRows] = await Promise.all([
      ctx.db.query("jurisdictions")
        .withIndex("by_legacyCountryCode_and_status", (q) =>
          q.eq("legacyCountryCode", country).eq("status", "enabled"))
        .take(2),
      ctx.db.query("jurisdictions")
        .withIndex("by_code", (q) => q.eq("code", country)).take(2),
    ]);
    if (canonical.length > 1 || codeRows.length > 1 ||
      (canonical[0] && codeRows[0] && canonical[0]._id !== codeRows[0]._id)) return null;
    const row = canonical[0] ?? (country === "GH" ? codeRows[0] : undefined);
    if (!row || row.status !== "enabled") return null;
    return await validateLegacyGeographicJurisdiction(ctx, row, country);
  }

  const defaults = await ctx.db.query("jurisdictions")
    .withIndex("by_isDefault_and_status", (q) =>
      q.eq("isDefault", true).eq("status", "enabled"))
    .take(2);
  if (defaults.length !== 1) return null;
  const country = defaults[0].legacyCountryCode ?? defaults[0].code;
  if (!country || !isLegacyCountryCode(country)) return null;
  const resolved = await resolveLegacyJurisdictionSnapshot(ctx, country);
  return resolved?.jurisdictionId === defaults[0]._id ? resolved : null;
}
