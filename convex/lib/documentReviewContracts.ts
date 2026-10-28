import { v } from "convex/values";
import { PUBLICATION_FILTER_PROTOCOL } from "../../shared/gemini-publication-filter";

export const documentReviewStatusValidator = v.union(
  v.literal("reading"), v.literal("awaiting_input"), v.literal("checking"),
  v.literal("completed"), v.literal("failed"), v.literal("cancelled"),
);
export const findingStatusValidator = v.union(v.literal("attention"), v.literal("check"), v.literal("fine"), v.literal("unconfirmed"));
export const documentReviewFailureValidator = v.union(
  v.literal("unreadable"), v.literal("too_large"), v.literal("not_configured"), v.literal("provider"),
  v.literal("research_unavailable"), v.literal("timeout"), v.literal("cancelled"), v.literal("internal"),
);
export const documentReviewOptionValidator = v.object({ id: v.string(), label: v.string() });
export const documentReviewCountsValidator = v.object({
  attention: v.number(), check: v.number(), fine: v.number(), unconfirmed: v.number(),
});
const relationValidator = v.union(v.literal("selected"), v.literal("geographic_ancestor"), v.literal("organizational_geography"));
const jurisdictionKindValidator = v.union(v.literal("geographic"), v.literal("organizational"));

/** Stored with each finding. The provenance stays server-side and is rechecked before a source opens. */
export const storedFindingCitationValidator = v.object({
  label: v.string(),
  provision: v.optional(v.string()),
  jurisdictionId: v.id("jurisdictions"),
  jurisdictionName: v.string(),
  jurisdictionKind: jurisdictionKindValidator,
  relation: relationValidator,
  resourceId: v.id("legalResources"),
  versionId: v.id("documentVersions"),
  providerStoreName: v.string(),
  providerDocumentName: v.optional(v.string()),
  pageNumber: v.optional(v.number()),
});

/** What a browser receives for a citation. */
export const publicFindingCitationValidator = v.object({
  label: v.string(),
  provision: v.optional(v.string()),
  jurisdictionName: v.string(),
  jurisdictionKind: jurisdictionKindValidator,
  relation: relationValidator,
  pageNumber: v.optional(v.number()),
  previewable: v.boolean(),
});

/** One finding proposed by the checking model, before its citations are validated. */
export const proposedFindingValidator = v.object({
  segmentOrdinal: v.optional(v.number()),
  kind: v.union(v.literal("passage"), v.literal("missing")),
  status: findingStatusValidator,
  title: v.string(),
  meaning: v.string(),
  lawSummary: v.string(),
  recommendation: v.string(),
  suggestedWording: v.optional(v.string()),
  provisions: v.array(v.string()),
  citations: v.array(v.object({
    jurisdictionId: v.string(),
    resourceId: v.string(),
    versionId: v.string(),
    providerStoreName: v.string(),
    providerDocumentName: v.optional(v.string()),
    pageNumber: v.optional(v.number()),
    provision: v.optional(v.string()),
  })),
});

export const readingSegmentValidator = v.object({
  ref: v.optional(v.string()),
  heading: v.optional(v.string()),
  text: v.string(),
  page: v.optional(v.number()),
  excerpt: v.boolean(),
  priority: v.union(v.literal("key"), v.literal("standard"), v.literal("boilerplate")),
  topics: v.array(v.string()),
});

export const readingResultValidator = v.object({
  documentType: v.string(),
  title: v.string(),
  summary: v.string(),
  parties: v.array(v.object({ role: v.string(), name: v.optional(v.string()) })),
  roleOptions: v.array(documentReviewOptionValidator),
  focusOptions: v.array(documentReviewOptionValidator),
  suggestedRoleId: v.optional(v.string()),
  suggestedFocusIds: v.array(v.string()),
  userGoal: v.string(),
  scope: v.union(v.literal("full"), v.literal("targeted")),
  isLegalDocument: v.boolean(),
  segments: v.array(readingSegmentValidator),
});

/** The research scope captured when checking starts, while the person's own access applies. */
export const researchSnapshotValidator = v.object({
  authorizedScopeSize: v.number(),
  partialCoverage: v.boolean(),
  stores: v.array(v.object({
    jurisdictionId: v.id("jurisdictions"),
    name: v.string(),
    kind: jurisdictionKindValidator,
    relation: relationValidator,
    storeName: v.string(),
    publicationFilter: v.optional(v.object({
      protocol: v.literal(PUBLICATION_FILTER_PROTOCOL),
      environment: v.string(),
      documents: v.array(v.object({ resourceId: v.string(), versionId: v.string(), sha256: v.string() })),
    })),
  })),
});
