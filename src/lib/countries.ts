export type ResearchJurisdictionKind = "geographic" | "organizational";

/** Browser-safe selection returned by the unified jurisdiction catalog. */
export interface ResearchJurisdiction {
  id: string;
  name: string;
  slug: string;
  kind: ResearchJurisdictionKind;
  isDefault: boolean;
}

export interface ChatCitation {
  label: string;
  jurisdictionId: string;
  jurisdictionName: string;
  jurisdictionKind: ResearchJurisdictionKind;
  relation: "selected" | "geographic_ancestor" | "organizational_geography";
}

export interface PartialCoverage {
  jurisdictionId: string;
  name: string;
  kind: ResearchJurisdictionKind;
  relation: "geographic_ancestor" | "organizational_geography";
}
