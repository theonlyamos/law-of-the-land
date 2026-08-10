/** Public display metadata loaded from the governed Convex catalog. */
export interface Country {
  /** ISO 3166-1 alpha-2 code, e.g. "GH". */
  code: string;
  name: string;
}

/** Browser-safe public display metadata from the governed jurisdiction catalog. */
export interface PublicJurisdiction {
  code: string;
  name: string;
  slug: string;
  isDefault: boolean;
}

export type ResearchJurisdictionKind = "geographic" | "organizational";

/** Browser-safe selection returned by the unified jurisdiction catalog. */
export interface ResearchJurisdiction {
  id: string;
  name: string;
  slug: string;
  kind: ResearchJurisdictionKind;
  isDefault: boolean;
  legacyCountryCode?: string;
}

/** Temporary compatibility handoff; IDs become authoritative in Task 9. */
export function legacyCountryCodeForSelection(
  selection: ResearchJurisdiction | null,
): string | null {
  const code = selection?.legacyCountryCode;
  return code && /^[A-Z]{2}$/.test(code) ? code : null;
}

export function findCountry(
  countries: readonly Country[],
  code: string | null | undefined,
): Country | null {
  if (!code) return null;
  return countries.find((country) => country.code === code.toUpperCase()) ?? null;
}

export function findJurisdiction(
  jurisdictions: readonly PublicJurisdiction[],
  code: string | null | undefined,
): PublicJurisdiction | null {
  if (!code) return null;
  const normalized = code.trim().toUpperCase();
  return jurisdictions.find((item) => item.code === normalized) ?? null;
}

export function chooseJurisdictionCode(
  jurisdictions: readonly PublicJurisdiction[],
  currentCode: string | null | undefined,
): string {
  return (
    findJurisdiction(jurisdictions, currentCode)?.code ??
    jurisdictions.find((item) => item.isDefault)?.code ??
    jurisdictions[0]?.code ??
    ""
  );
}
