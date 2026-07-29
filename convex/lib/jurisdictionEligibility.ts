import type { Doc } from "../_generated/dataModel";

export function normalizePositiveSafeIntegerBucketId(value: string): string | null {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const bucketId = Number(normalized);
  return Number.isSafeInteger(bucketId) && bucketId > 0 ? normalized : null;
}

export function isPublicJurisdictionEligible(
  jurisdiction: Pick<Doc<"jurisdictions">, "status" | "productionBucketId">,
): boolean {
  return (
    jurisdiction.status === "enabled" &&
    jurisdiction.productionBucketId !== undefined &&
    normalizePositiveSafeIntegerBucketId(jurisdiction.productionBucketId) !== null
  );
}
