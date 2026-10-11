import { v } from "convex/values";

export const citationPassageValidator = v.object({ pageNumber: v.number(), quote: v.string() });
export const citationPreviewValidator = v.object({ pageNumber: v.optional(v.number()), passages: v.optional(v.array(citationPassageValidator)) });
// Only proof-validated completion writes claims; only claim consumption writes
// saved provenance. Neither shape is accepted by the public append mutation.
export const citationProvenanceValidator = v.object({
  jurisdictionId: v.id("jurisdictions"), resourceId: v.id("legalResources"), versionId: v.id("documentVersions"),
  providerStoreName: v.string(), providerDocumentName: v.string(), expectedSha256: v.string(), expectedByteSize: v.number(),
  pageNumber: v.optional(v.number()), passages: v.optional(v.array(citationPassageValidator)),
});
