import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { action, internalQuery, query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { canAccessSession, validateGovernedCitations, revalidateReviewedEmploymentJobPrincipal, type VerifiedReviewedEmploymentJobPrincipal } from "./chats";
import { resolveChatResearchStoresForJurisdiction } from "./jurisdictions";
import { requireUserId } from "./lib/requireUser";
import { authComponent } from "./auth";
import { reviewedEmploymentBackendPolicy, reviewedEmploymentBackendPolicyId } from "../shared/reviewed-employment-policy";
import { PUBLICATION_FILTER_PROTOCOL } from "../shared/gemini-publication-filter";

const unavailable = () => ({ status: "unavailable" as const });

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function applicable(row: { effectiveDate?: string; repealDate?: string }, asOfDate: string): boolean {
  return (row.effectiveDate === undefined || (validDate(row.effectiveDate) && row.effectiveDate <= asOfDate))
    && (row.repealDate === undefined || (validDate(row.repealDate) && row.repealDate > asOfDate));
}

function storageHashMatches(base64: string, expected: string): boolean {
  const bytes = atob(base64);
  return bytes.length === 32 && Array.from(bytes, byte => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("") === expected;
}

/** Session-scoped edition eligibility for ordinary authenticated research users.
 * The caller's expected identity is a selector, never an access grant. The Next
 * adapter separately binds it to the fixed reviewed ACT 651 registry and supplies
 * the current UTC date. This query certifies neither current law nor page content.
 * The existing atomic completion and citation-claim consumption remain mandatory.
 */
export type ReviewedEmploymentSourceAuthorizationInput = {
  publicationFilterProtocol?: typeof PUBLICATION_FILTER_PROTOCOL;
  externalId: string; jurisdictionId: Id<"jurisdictions">; resourceId: Id<"legalResources">;
  versionId: Id<"documentVersions">; expectedSha256: string; expectedByteSize: number; asOfDate: string;
};
async function authorizeSourceHandler(
  ctx: QueryCtx, args: ReviewedEmploymentSourceAuthorizationInput, jobPrincipal?: VerifiedReviewedEmploymentJobPrincipal,
) {
if (args.externalId.length > 256 || !args.externalId.trim() || args.externalId !== args.externalId.trim()
  || !/^[a-f0-9]{64}$/.test(args.expectedSha256) || !Number.isSafeInteger(args.expectedByteSize)
  || args.expectedByteSize <= 0 || args.expectedByteSize > 32 * 1024 * 1024 || !validDate(args.asOfDate)) return unavailable();
try {
  const verified = jobPrincipal ? await revalidateReviewedEmploymentJobPrincipal(ctx, jobPrincipal,
    { externalId: args.externalId, jurisdictionId: args.jurisdictionId }) : null;
  const userId = verified?.ownerId ?? await requireUserId(ctx);
  const session = verified?.session ?? await ctx.db.query("chatSessions").withIndex("by_user_externalId", q =>
    q.eq("userId", userId).eq("externalId", args.externalId)).unique();
  if (!session || session.jurisdictionId !== args.jurisdictionId || !(await canAccessSession(ctx, session))) return unavailable();
  const resolution = await resolveChatResearchStoresForJurisdiction(ctx, args.jurisdictionId, args.publicationFilterProtocol);
  const selected = resolution.stores[0];
  if (!selected || selected.jurisdictionId !== args.jurisdictionId || selected.relation !== "selected"
    || selected.kind !== "geographic") return unavailable();
  const [resource, version] = await Promise.all([
    ctx.db.get("legalResources", args.resourceId), ctx.db.get("documentVersions", args.versionId),
  ]);
  if (!resource || resource.jurisdictionId !== args.jurisdictionId || resource.status !== "active"
    || resource.catalogPublished !== true || resource.activeVersionId !== args.versionId
    || !version || version.resourceId !== args.resourceId || version.status !== "published"
    || version.sha256 !== args.expectedSha256 || version.byteSize !== args.expectedByteSize
    || version.mimeType !== "application/pdf" || !applicable(resource, args.asOfDate) || !applicable(version, args.asOfDate)) return unavailable();
  const storage = await ctx.db.system.get("_storage", version.originalStorageId);
  if (!storage || storage.size !== args.expectedByteSize || !storageHashMatches(storage.sha256, args.expectedSha256)) return unavailable();
  // Reuses the exact completion rules for provider linkage and all lifecycle
  // locks, including expired locks awaiting reconciliation. Nothing is emitted.
  await validateGovernedCitations(ctx, resolution.stores, [{ jurisdictionId: args.jurisdictionId,
    resourceId: args.resourceId, versionId: args.versionId, providerStoreName: selected.storeName }]);
  return { status: "authorized" as const, externalId: args.externalId, jurisdictionId: args.jurisdictionId,
    resourceId: args.resourceId, versionId: args.versionId, sha256: version.sha256, byteSize: version.byteSize,
    asOfDate: args.asOfDate, resourceEffectiveDate: resource.effectiveDate ?? null,
    resourceRepealDate: resource.repealDate ?? null, versionEffectiveDate: version.effectiveDate ?? null,
    versionRepealDate: version.repealDate ?? null };
} catch {
  // Authentication changes, invalid scope and stale catalog data all have the
  // same closed response; do not expose backend errors or private identifiers.
  return unavailable();
}
}

export async function authorizeSourceForJobPrincipal(
  ctx: QueryCtx, args: ReviewedEmploymentSourceAuthorizationInput, principal: VerifiedReviewedEmploymentJobPrincipal,
) {
  return await authorizeSourceHandler(ctx, args, principal);
}

export const authorizeSource = query({
  args: {
    publicationFilterProtocol: v.optional(v.literal(PUBLICATION_FILTER_PROTOCOL)),
    externalId: v.string(), jurisdictionId: v.id("jurisdictions"), resourceId: v.id("legalResources"),
    versionId: v.id("documentVersions"), expectedSha256: v.string(), expectedByteSize: v.number(), asOfDate: v.string(),
  },
  returns: v.union(v.object({ status: v.literal("unavailable") }), v.object({
    status: v.literal("authorized"), externalId: v.string(), jurisdictionId: v.id("jurisdictions"),
    resourceId: v.id("legalResources"), versionId: v.id("documentVersions"), sha256: v.string(), byteSize: v.number(),
    asOfDate: v.string(), resourceEffectiveDate: v.union(v.string(), v.null()), resourceRepealDate: v.union(v.string(), v.null()),
    versionEffectiveDate: v.union(v.string(), v.null()), versionRepealDate: v.union(v.string(), v.null()),
  })),
  handler: authorizeSourceHandler,
});

const authorizeSourceRef = makeFunctionReference<"query">("reviewedEmployment:authorizeSource");
const citationFileArgs = { externalId: v.string(), messageId: v.id("messages"), citationIndex: v.number() };
const citationFileResult = v.union(v.null(), v.object({ url: v.string(), filename: v.string(), mimeType: v.literal("application/pdf"), byteSize: v.number() }));
const citationFileAtDateRef = makeFunctionReference<"query">("reviewedEmployment:resolveCitationFileAtDate");

// Actions are not cached: the current UTC date is supplied only by this server
// boundary, never by a browser. The internal query grants access in one snapshot.
export const resolveCitationFile = action({
  args: citationFileArgs, returns: citationFileResult,
  handler: async (ctx, args): Promise<{ url: string; filename: string; mimeType: "application/pdf"; byteSize: number } | null> => {
    // The uncached action also checks native session expiry; a cached query's
    // database reads alone cannot observe the passage of time.
    if (!(await authComponent.safeGetAuthUser(ctx))) return null;
    return await ctx.runQuery(citationFileAtDateRef, { ...args, asOfDate: new Date().toISOString().slice(0, 10) });
  },
});

/** Resolves an original only for the owner of a saved, verified answer. The
 * message/index select server-owned provenance, never an arbitrary catalog file.
 * Current publication, scope, hash, storage and lifecycle checks still apply.
 */
export const resolveCitationFileAtDate = internalQuery({
  args: { ...citationFileArgs, asOfDate: v.string() },
  returns: citationFileResult,
  handler: async (ctx, args) => {
    if (!args.externalId.trim() || args.externalId !== args.externalId.trim() || args.externalId.length > 200
      || !Number.isSafeInteger(args.citationIndex) || args.citationIndex < 0 || args.citationIndex > 3) return null;
    try {
      const userId = await requireUserId(ctx);
      const session = await ctx.db.query("chatSessions").withIndex("by_user_externalId", q =>
        q.eq("userId", userId).eq("externalId", args.externalId)).unique();
      if (!session || !(await canAccessSession(ctx, session))) return null;
      const message = await ctx.db.get(args.messageId);
      const source = message?.reviewedOriginalSource;
      const citation = message?.citations?.[args.citationIndex];
      const page = source?.pageNumbers[args.citationIndex];
      // Saved-answer reads use the fixed deployment source policy independently
      // of new-admission/execution controls, retaining owner access on rollback.
      const policy = reviewedEmploymentBackendPolicy(process.env), policyId = reviewedEmploymentBackendPolicyId(process.env);
      if (!message || message.sessionId !== session._id || message.role !== "assistant" || message.answerKind !== "legal"
        || !source || !citation || !Number.isInteger(page) || ![11, 12, 18, 21].includes(page!)
        || source.pageNumbers.length !== message.citations?.length
        || source.pageNumbers.length < 1 || source.pageNumbers.length > 4
        || citation.jurisdictionId !== source.jurisdictionId || citation.relation !== "selected"
        || !policy || (policyId === "act651-s55-prod-v1" && source.pageNumbers.some(number => number !== 18))
        || !Object.entries(policy).every(([key, value]) => source[key as keyof typeof policy] === value)) return null;
      const { pageNumbers: _pages, ...identity } = source;
      const grant: { status: "authorized" | "unavailable" } = await ctx.runQuery(authorizeSourceRef,
        { ...identity, externalId: args.externalId, asOfDate: args.asOfDate, publicationFilterProtocol: PUBLICATION_FILTER_PROTOCOL });
      if (grant.status !== "authorized") return null;
      const version = await ctx.db.get(source.versionId);
      if (!version || version.mimeType !== "application/pdf") return null;
      const url = await ctx.storage.getUrl(version.originalStorageId);
      return url ? { url, filename: version.filename, mimeType: "application/pdf" as const, byteSize: version.byteSize } : null;
    } catch { return null; }
  },
});
