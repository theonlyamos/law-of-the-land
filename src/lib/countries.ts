/**
 * Static display metadata for supported jurisdictions. Runtime availability
 * and provider configuration are resolved from the governed Convex catalog.
 *
 * The country code is stored on each chat session so conversations stay
 * scoped to the jurisdiction they were started in.
 */
export interface Country {
  /** ISO 3166-1 alpha-2 code, e.g. "GH". */
  code: string;
  name: string;
}

export const COUNTRIES: Country[] = [
  { code: "GH", name: "Ghana" },
];

export const DEFAULT_COUNTRY = COUNTRIES[0];

export function findCountry(code: string | null | undefined): Country | null {
  if (!code) return null;
  return COUNTRIES.find((country) => country.code === code.toUpperCase()) ?? null;
}
