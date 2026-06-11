/**
 * Supported jurisdictions. Each country maps to the GroundX bucket that holds
 * its legal document library — adding a country is one entry here (the IDs are
 * not secret; they are unusable without the server's API key).
 *
 * The country code is stored on each chat session so conversations stay
 * scoped to the jurisdiction they were started in.
 */
export interface Country {
  /** ISO 3166-1 alpha-2 code, e.g. "GH". */
  code: string;
  name: string;
  groundxBucketId: number;
}

export const COUNTRIES: Country[] = [
  { code: "GH", name: "Ghana", groundxBucketId: 11833 },
];

export const DEFAULT_COUNTRY = COUNTRIES[0];

export function findCountry(code: string | null | undefined): Country | null {
  if (!code) return null;
  return COUNTRIES.find((country) => country.code === code.toUpperCase()) ?? null;
}
