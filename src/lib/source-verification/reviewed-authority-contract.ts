import type { SourceIdentity } from "./evidence";

/** Pure source-edition authority contract. Deployment admission remains separate. */
export type ReviewedSourceManifest = {
  authorizedScopeSize: number;
  stores: {
    jurisdictionId: string;
    name: string;
    kind: "geographic" | "organizational";
    relation: "selected" | "geographic_ancestor" | "organizational_geography";
    storeName: string;
  }[];
  partialCoverage: boolean;
};
export type ReviewedSourceAuthorityInput = Readonly<{
  jurisdictionId: string;
  sources: readonly Readonly<{ sourceId: string; versionId: string }>[];
  deadlineAt: number;
  signal: AbortSignal;
}>;
export type ReviewedSourceAuthorityReason = "invalid_request" | "invalid_deadline" | "aborted" | "deadline_exceeded"
  | "authority_unavailable" | "catalog_mismatch" | "source_not_applicable" | "manifest_invalid";
export type ReviewedSourceAuthorityResult = Readonly<{
  status: "unavailable"; reason: ReviewedSourceAuthorityReason; productionEligible: false;
}> | Readonly<{
  status: "authorized";
  identities: readonly Readonly<SourceIdentity>[];
  manifest: ReviewedSourceManifest;
  citationIdentity: Readonly<{ jurisdictionId: string; resourceId: string; versionId: string; providerStoreName: string }>;
  applicability: "source_edition_only";
  requiresFinalAtomicCompletion: true;
  productionEligible: false;
}>;
