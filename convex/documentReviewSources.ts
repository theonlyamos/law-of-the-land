import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { action, internalQuery } from "./_generated/server";
import { citationSourceUserId } from "./lib/citationSourceAccess";
import { verifyTelemetryServiceProof } from "./lib/telemetryProof";
import { canAccessSession, validateGovernedCitations } from "./chats";
import { resolveChatResearchStoresForJurisdiction } from "./jurisdictions";
import { PUBLICATION_FILTER_PROTOCOL } from "../shared/gemini-publication-filter";
import { DOCUMENT_REVIEW_LIMITS, documentReviewSourceProofParts } from "../shared/document-review";

const selectorValidator = { reviewId: v.id("documentReviews"), findingId: v.id("documentReviewFindings"), citationIndex: v.number() };
const fileValidator = v.union(v.null(), v.object({ url: v.string(), filename: v.string(), mimeType: v.literal("application/pdf"), byteSize: v.number() }));
type SourceFile = { url: string; filename: string; mimeType: "application/pdf"; byteSize: number };
const resolveRef = makeFunctionReference<"query", { reviewId: Id<"documentReviews">; findingId: Id<"documentReviewFindings">; citationIndex: number }, SourceFile | null>(
  "documentReviewSources:resolveCitationFileInternal",
);

/** Opens the original PDF behind one review citation, after rechecking the owner, scope and file. */
export const resolveCitationFile = action({
  args: { ...selectorValidator, expiresAt: v.number(), serviceProof: v.string() },
  returns: fileValidator,
  handler: async (ctx, args): Promise<SourceFile | null> => {
    if (!Number.isSafeInteger(args.expiresAt) || args.expiresAt <= Date.now() || args.expiresAt > Date.now() + 60_000) return null;
    try {
      if (!(await verifyTelemetryServiceProof(args.serviceProof, documentReviewSourceProofParts(args)))) return null;
    } catch { return null; }
    if (!(await citationSourceUserId(ctx))) return null;
    return await ctx.runQuery(resolveRef, { reviewId: args.reviewId, findingId: args.findingId, citationIndex: args.citationIndex });
  },
});

export const resolveCitationFileInternal = internalQuery({
  args: selectorValidator,
  returns: fileValidator,
  handler: async (ctx, args): Promise<SourceFile | null> => {
    if (!Number.isSafeInteger(args.citationIndex) || args.citationIndex < 0 || args.citationIndex >= DOCUMENT_REVIEW_LIMITS.maxCitationsPerFinding) return null;
    try {
      const userId = await citationSourceUserId(ctx);
      if (!userId) return null;
      const [review, finding] = await Promise.all([ctx.db.get("documentReviews", args.reviewId), ctx.db.get("documentReviewFindings", args.findingId)]);
      if (!review || review.userId !== userId || !finding || finding.reviewId !== review._id || finding.attempt !== review.attempt) return null;
      const session = await ctx.db.get("chatSessions", review.sessionId);
      if (!session || session.userId !== userId || !session.jurisdictionId || !(await canAccessSession(ctx, session))) return null;
      const citation = finding.citations[args.citationIndex];
      if (!citation) return null;
      const { stores } = await resolveChatResearchStoresForJurisdiction(ctx, session.jurisdictionId, PUBLICATION_FILTER_PROTOCOL);
      await validateGovernedCitations(ctx, stores, [{
        jurisdictionId: citation.jurisdictionId,
        resourceId: citation.resourceId,
        versionId: citation.versionId,
        providerStoreName: citation.providerStoreName,
        ...(citation.providerDocumentName ? { providerDocumentName: citation.providerDocumentName } : {}),
        ...(citation.pageNumber === undefined ? {} : { pageNumber: citation.pageNumber }),
      }]);
      const [resource, version] = await Promise.all([ctx.db.get("legalResources", citation.resourceId), ctx.db.get("documentVersions", citation.versionId)]);
      if (!resource || resource.catalogPublished !== true || !version || version.mimeType !== "application/pdf"
        || !Number.isSafeInteger(version.byteSize) || version.byteSize < 1 || version.byteSize > 32 * 1024 * 1024) return null;
      const storage = await ctx.db.system.get("_storage", version.originalStorageId);
      if (!storage || (storage.contentType !== undefined && storage.contentType !== "application/pdf") || storage.size !== version.byteSize) return null;
      const url = await ctx.storage.getUrl(version.originalStorageId);
      return url ? { url, filename: version.filename, mimeType: "application/pdf", byteSize: version.byteSize } : null;
    } catch {
      return null;
    }
  },
});
