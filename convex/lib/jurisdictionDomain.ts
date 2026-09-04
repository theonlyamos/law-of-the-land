import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";

export type JurisdictionKind = "geographic" | "organizational";
export type JurisdictionVisibility = "public" | "members";
export type OrganizationClass =
  | "intergovernmental"
  | "government"
  | "company"
  | "university"
  | "nonprofit"
  | "professional_association"
  | "other";
export type OrganizationStatus = "active" | "archived";
export type OrganizationMembershipStatus = "active" | "inactive";
export type OrganizationScopeMode = "global" | "linked_geographies";
export type GeographicLevel =
  | "country"
  | "state"
  | "province"
  | "region"
  | "district"
  | "city"
  | "town"
  | "territory"
  | "other_locality";

export const MAX_GEOGRAPHIC_DEPTH = 8;
export const MAX_SELECTOR_PAGE_SIZE = 20;
export const MAX_RETRIEVAL_LIBRARIES = 4;
export const MAX_ACTIVE_ORGANIZATION_MEMBERSHIPS = 100;

export const jurisdictionKindValidator = v.union(
  v.literal("geographic"),
  v.literal("organizational"),
);
export const jurisdictionVisibilityValidator = v.union(
  v.literal("public"),
  v.literal("members"),
);
export const organizationClassValidator = v.union(
  v.literal("intergovernmental"),
  v.literal("government"),
  v.literal("company"),
  v.literal("university"),
  v.literal("nonprofit"),
  v.literal("professional_association"),
  v.literal("other"),
);
export const organizationStatusValidator = v.union(
  v.literal("active"),
  v.literal("archived"),
);
export const organizationMembershipStatusValidator = v.union(
  v.literal("active"),
  v.literal("inactive"),
);
export const organizationScopeModeValidator = v.union(
  v.literal("global"),
  v.literal("linked_geographies"),
);
export const geographicLevelValidator = v.union(
  v.literal("country"),
  v.literal("state"),
  v.literal("province"),
  v.literal("region"),
  v.literal("district"),
  v.literal("city"),
  v.literal("town"),
  v.literal("territory"),
  v.literal("other_locality"),
);

const jurisdictionStatusValidator = v.union(
  v.literal("draft"),
  v.literal("enabled"),
  v.literal("archived"),
);
const providerSyncStateValidator = v.union(
  v.literal("pending"),
  v.literal("synced"),
  v.literal("drifted"),
  v.literal("failed"),
);

export const jurisdictionDocumentValidator = v.object({
  _id: v.id("jurisdictions"),
  _creationTime: v.number(),
  code: v.optional(v.string()),
  name: v.string(),
  slug: v.string(),
  status: jurisdictionStatusValidator,
  isDefault: v.boolean(),
  geminiFileSearchStoreName: v.optional(v.string()),
  geminiEmbeddingModel: v.optional(v.string()),
  providerSyncState: providerSyncStateValidator,
  kind: v.optional(jurisdictionKindValidator),
  visibility: v.optional(jurisdictionVisibilityValidator),
  organizationId: v.optional(v.id("organizations")),
  legacyCountryCode: v.optional(v.string()),
  createdBy: v.string(),
  updatedBy: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const jurisdictionSearchPageValidator = v.object({
  page: v.array(
    v.object({
      id: v.id("jurisdictions"),
      name: v.string(),
      slug: v.string(),
      kind: jurisdictionKindValidator,
      isDefault: v.boolean(),
    }),
  ),
  group: v.union(
    v.literal("geographic"),
    v.literal("your_organizations"),
    v.literal("public_organizations"),
  ),
  isDone: v.boolean(),
  continueCursor: v.union(v.string(), v.null()),
});

export const researchScopeItemValidator = v.object({
  jurisdictionId: v.id("jurisdictions"),
  name: v.string(),
  kind: jurisdictionKindValidator,
  relation: v.union(
    v.literal("selected"),
    v.literal("geographic_ancestor"),
    v.literal("organizational_geography"),
  ),
});

export const researchScopeValidator = v.object({
  selectedJurisdictionId: v.id("jurisdictions"),
  items: v.array(researchScopeItemValidator),
});

export const chatCitationValidator = v.object({
  label: v.string(),
  jurisdictionId: v.id("jurisdictions"),
  jurisdictionName: v.string(),
  jurisdictionKind: jurisdictionKindValidator,
  relation: v.union(
    v.literal("selected"),
    v.literal("geographic_ancestor"),
    v.literal("organizational_geography"),
  ),
});

export type ResearchScopeItem = {
  jurisdictionId: Id<"jurisdictions">;
  name: string;
  kind: JurisdictionKind;
  relation: "selected" | "geographic_ancestor" | "organizational_geography";
};

export type ResearchScope = {
  selectedJurisdictionId: Id<"jurisdictions">;
  items: ResearchScopeItem[];
};

export type ChatCitation = {
  label: string;
  jurisdictionId: Id<"jurisdictions">;
  jurisdictionName: string;
  jurisdictionKind: JurisdictionKind;
  relation: ResearchScopeItem["relation"];
};

export const allowedParentLevelsByLevel: Readonly<
  Record<GeographicLevel, readonly GeographicLevel[]>
> = {
  country: [],
  state: ["country"],
  province: ["country"],
  region: ["country"],
  territory: ["country"],
  district: ["country", "state", "province", "region", "territory"],
  city: ["country", "state", "province", "region", "territory", "district"],
  town: ["country", "state", "province", "region", "territory", "district"],
  other_locality: ["country", "state", "province", "region", "territory", "district"],
};

export function normalizePlaceId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 255) {
    throw new ConvexError("INVALID_GOOGLE_PLACE_ID");
  }
  return normalized;
}

export function normalizeGeographicAlias(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

export function normalizeJurisdictionSlug(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) || normalized.length > 80) {
    throw new ConvexError("INVALID_JURISDICTION_SLUG");
  }
  return normalized;
}

export function assertGeographicLevel(value: string): GeographicLevel {
  if (!(value in allowedParentLevelsByLevel)) {
    throw new ConvexError("INVALID_GEOGRAPHIC_LEVEL");
  }
  return value as GeographicLevel;
}

export function projectJurisdictionKind(value: { kind?: JurisdictionKind }): JurisdictionKind {
  return value.kind ?? "geographic";
}

export function projectJurisdictionVisibility(
  value: { visibility?: JurisdictionVisibility },
): JurisdictionVisibility {
  return value.visibility ?? "public";
}

export function isLegacyCountryCode(value: string | undefined): value is string {
  return value !== undefined && /^[A-Z]{2}$/.test(value);
}
