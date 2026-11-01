/** Identity collisions require individual review; they never authorize merging cases. */
export function batchIdentityKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\b(?:versus|vs)\b\.?/g, "v").replace(/[^\p{L}\p{N}]/gu, "");
}
