/** Public display metadata loaded from the governed Convex catalog. */
export interface Country {
  /** ISO 3166-1 alpha-2 code, e.g. "GH". */
  code: string;
  name: string;
}

export function findCountry(
  countries: readonly Country[],
  code: string | null | undefined,
): Country | null {
  if (!code) return null;
  return countries.find((country) => country.code === code.toUpperCase()) ?? null;
}
