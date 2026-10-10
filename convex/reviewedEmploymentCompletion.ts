import { makeFunctionReference, type FunctionArgs, type FunctionReturnType } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import type { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./_generated/server";
import { completeGovernedInteractionProofParts, completeGovernedInteractionForJobPrincipal,
  appendMessagesForJobPrincipal, revalidateReviewedEmploymentJobPrincipal,
  type VerifiedReviewedEmploymentJobPrincipal } from "./chats";
import { authorizeSourceForJobPrincipal } from "./reviewedEmployment";
import { MAX_CONTEXT_ATTACHMENTS, MAX_MESSAGE_ATTACHMENTS } from "./lib/chatAttachmentContracts";
import { chatCitationValidator } from "./lib/jurisdictionDomain";
import { queryDiagnosticsValidator, validateQueryDiagnostics } from "./lib/queryDiagnostics";
import { requireUserId } from "./lib/requireUser";
import { createTelemetryServiceProof, isOpaqueTelemetryToken, verifyTelemetryServiceProof } from "./lib/telemetryProof";
import { reviewedEmploymentBackendPolicy, reviewedEmploymentBackendPolicyId,
  reviewedEmploymentBackendExecutionAllowed } from "../shared/reviewed-employment-policy";
import { PUBLICATION_FILTER_PROTOCOL } from "../shared/gemini-publication-filter";

const sourceValidator = v.object({ jurisdictionId: v.id("jurisdictions"), resourceId: v.id("legalResources"),
  versionId: v.id("documentVersions"), expectedSha256: v.string(), expectedByteSize: v.number(), asOfDate: v.string() });
const completionValidator = v.object({
  publicationFilterProtocol: v.optional(v.literal(PUBLICATION_FILTER_PROTOCOL)),
  publicationFilterBinding: v.optional(v.string()),
  diagnostics: v.optional(queryDiagnosticsValidator), routeNonce: v.string(), externalId: v.string(), jurisdictionId: v.string(),
  assistantClientId: v.string(), finalAnswer: v.string(), answerKind: v.literal("legal"), outcome: v.literal("success"),
  citations: v.array(v.object({ jurisdictionId: v.string(), resourceId: v.string(), versionId: v.string(),
    providerStoreName: v.string(), providerDocumentName: v.optional(v.string()), pageNumber: v.optional(v.number()) })),
  model: v.string(), elapsedMs: v.number(), authorizedScopeSize: v.number(), readyStoreCount: v.number(), partialCoverage: v.boolean(),
  jurisdictionCoverage: v.array(v.object({ ordinal: v.number(),
    relation: v.union(v.literal("selected"), v.literal("geographic_ancestor"), v.literal("organizational_geography")),
    coverage: v.union(v.literal("evidence"), v.literal("no_evidence"), v.literal("unavailable"), v.literal("not_searched")) })),
  attachmentIds: v.array(v.id("chatAttachments")),
});
const userValidator = v.object({ clientId: v.string(), content: v.string(), attachmentIds: v.array(v.id("chatAttachments")) });
export type ReviewedEmploymentCommitInput = { completion: Infer<typeof completionValidator>;
  source: Infer<typeof sourceValidator>; user: Infer<typeof userValidator> };
type ReviewedEmploymentCommitResult = Extract<
  Awaited<ReturnType<typeof completeGovernedInteractionForJobPrincipal>>,
  { status: "completed"; outcome: "success" }
> & { answerKind: "legal"; persisted: true };
const authorizeRef = makeFunctionReference<"query", Infer<typeof sourceValidator> & { externalId: string; publicationFilterProtocol?: typeof PUBLICATION_FILTER_PROTOCOL },
  { status: "authorized" | "unavailable" }>("reviewedEmployment:authorizeSource");
const completeRef = makeFunctionReference<"mutation", FunctionArgs<typeof api.chats.completeGovernedInteraction>,
  FunctionReturnType<typeof api.chats.completeGovernedInteraction>>("chats:completeGovernedInteraction");
const appendRef = makeFunctionReference<"mutation", FunctionArgs<typeof api.chats.appendMessages>,
  FunctionReturnType<typeof api.chats.appendMessages>>("chats:appendMessages");

/** Domain-separated proof binds the original complete input (including every
 * resolved attachment), fixed source identity/date and the exact new user turn.
 * The source and user fields cannot be replaced using an ordinary completion proof.
 */
export async function reviewedEmploymentCommitProofParts(input: ReviewedEmploymentCommitInput): Promise<readonly (string | number)[]> {
  return ["reviewed-employment-atomic-commit-v1", ...await completeGovernedInteractionProofParts(input.completion),
    "reviewed-source", input.source.jurisdictionId, input.source.resourceId, input.source.versionId,
    input.source.expectedSha256, input.source.expectedByteSize, input.source.asOfDate,
    "user-message", input.user.clientId, input.user.content, input.user.attachmentIds.length, ...input.user.attachmentIds];
}
function invalid(): never { throw new ConvexError("REVIEWED_EMPLOYMENT_COMMIT_INVALID"); }
function bounded(value: string, maximum: number): boolean { return value.length > 0 && value.length <= maximum && value === value.trim(); }
function count(value: number, maximum: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
function validateBounds({ completion, source, user }: ReviewedEmploymentCommitInput) {
  if (!isOpaqueTelemetryToken(completion.routeNonce) || !bounded(completion.externalId, 200)
    || !bounded(completion.assistantClientId, 200) || !bounded(user.clientId, 200)
    || user.clientId === completion.assistantClientId || !user.content.trim() || user.content.length > 4000
    || !completion.finalAnswer.trim() || new TextEncoder().encode(completion.finalAnswer).byteLength > 16 * 1024
    || !bounded(completion.model, 100) || !count(completion.elapsedMs, 600_000)
    || !count(completion.authorizedScopeSize, 4) || completion.authorizedScopeSize < 1
    || !count(completion.readyStoreCount, 4) || completion.readyStoreCount < 1
    || completion.citations.length < 1 || completion.citations.length > 4 || completion.jurisdictionCoverage.length > 4
    || completion.jurisdictionCoverage.some(item => !count(item.ordinal, 3))
    || completion.citations.some(item => !bounded(item.jurisdictionId, 128) || !bounded(item.resourceId, 128)
      || !bounded(item.versionId, 128) || !bounded(item.providerStoreName, 200)
      || (item.providerDocumentName !== undefined && !bounded(item.providerDocumentName, 400))
      || item.pageNumber === undefined || ![11, 12, 18, 21].includes(item.pageNumber))
    || !bounded(completion.jurisdictionId, 128) || !/^[a-f0-9]{64}$/.test(source.expectedSha256)
    || !Number.isSafeInteger(source.expectedByteSize) || source.expectedByteSize < 1 || source.expectedByteSize > 32 * 1024 * 1024
    || !/^\d{4}-\d{2}-\d{2}$/.test(source.asOfDate)
    || completion.attachmentIds.length > MAX_CONTEXT_ATTACHMENTS || new Set(completion.attachmentIds).size !== completion.attachmentIds.length
    || user.attachmentIds.length > MAX_MESSAGE_ATTACHMENTS || new Set(user.attachmentIds).size !== user.attachmentIds.length) invalid();
  if (completion.diagnostics !== undefined) validateQueryDiagnostics(completion.diagnostics);
}

/** Authorization, governed completion and exact persistence share one database
 * transaction. Nested failure escapes, rolling back every success write and claim.
 * This adds no broader behavior to ordinary chat completion or appendMessages.
 */
async function commitHandler(
  ctx: MutationCtx, args: ReviewedEmploymentCommitInput & { serviceProof: string },
  jobPrincipal?: VerifiedReviewedEmploymentJobPrincipal,
  jobCreatedAt?: number,
): Promise<ReviewedEmploymentCommitResult> {
validateBounds(args);
if (!(await verifyTelemetryServiceProof(args.serviceProof, await reviewedEmploymentCommitProofParts(args))))
  throw new ConvexError("REVIEWED_EMPLOYMENT_SERVICE_PROOF_INVALID");
const { completion, source, user } = args;
const policy = reviewedEmploymentBackendPolicy(process.env), policyId = reviewedEmploymentBackendPolicyId(process.env);
if (!policy || !reviewedEmploymentBackendExecutionAllowed(process.env)
  // Production success is reachable only through the worker's four passed
  // reservations and exact source/candidate binding, never synchronous commit.
  || (policyId === "act651-s55-prod-v1" && (!jobPrincipal || completion.citations.some(citation => citation.pageNumber !== 18)))
  || !Object.entries(policy).every(([key, value]) => source[key as keyof typeof policy] === value)
  || source.asOfDate !== new Date(Date.now()).toISOString().slice(0, 10)
  || completion.jurisdictionId !== source.jurisdictionId
  || completion.citations.some(citation => citation.jurisdictionId !== source.jurisdictionId
    || citation.resourceId !== source.resourceId || citation.versionId !== source.versionId)
  || user.attachmentIds.some(id => !completion.attachmentIds.includes(id))) invalid();
// runQuery is within the mutation's transactional snapshot, establishing read
// dependencies for catalog publication, original hash/storage, dates and locks.
const verified = jobPrincipal ? await revalidateReviewedEmploymentJobPrincipal(ctx, jobPrincipal,
  { externalId: completion.externalId, jurisdictionId: source.jurisdictionId }) : null;
const grant = verified
  ? await authorizeSourceForJobPrincipal(ctx, { externalId: completion.externalId, ...source, publicationFilterProtocol: completion.publicationFilterProtocol }, verified)
  : await ctx.runQuery(authorizeRef, { externalId: completion.externalId, ...source,
    ...(completion.publicationFilterProtocol ? { publicationFilterProtocol: completion.publicationFilterProtocol } : {}) });
if (grant.status !== "authorized") throw new ConvexError("REVIEWED_EMPLOYMENT_AUTHORITY_UNAVAILABLE");
const userId = verified?.ownerId ?? await requireUserId(ctx);
const session = verified?.session ?? await ctx.db.query("chatSessions").withIndex("by_user_externalId", q =>
  q.eq("userId", userId).eq("externalId", completion.externalId)).unique();
if (!session || session.jurisdictionId !== source.jurisdictionId) invalid();
const governedProof = await createTelemetryServiceProof(await completeGovernedInteractionProofParts(completion));
const result = verified
  ? await completeGovernedInteractionForJobPrincipal(ctx, { ...completion, serviceProof: governedProof }, verified)
  : await ctx.runMutation(completeRef, { ...completion, serviceProof: governedProof });
if (result.status === "replayed") throw new ConvexError("REVIEWED_EMPLOYMENT_REPLAY_UNAVAILABLE");
if (result.status !== "completed" || result.outcome !== "success" || result.answerKind !== "legal") invalid();
// The durable submission time keeps a delayed background pair in its original
// position. A newer turn still supplies the session preview; updatedAt continues
// to record this completion through the ordinary append transaction.
const submitted = jobCreatedAt === undefined ? {} : { createdAt: jobCreatedAt };
const latest = verified && jobCreatedAt !== undefined ? await ctx.db.query("messages")
  .withIndex("by_session_and_createdAt", q => q.eq("sessionId", session._id)).order("desc").first() : null;
const appendInput: Parameters<typeof appendMessagesForJobPrincipal>[1] = { externalId: completion.externalId, jurisdictionId: source.jurisdictionId,
  ...(session.messageCount === 0 ? { title: user.content.slice(0, 30) + (user.content.length > 30 ? "..." : "") } : {}),
  lastMessage: jobCreatedAt !== undefined && latest && latest.createdAt > jobCreatedAt ? latest.content : completion.finalAnswer, messages: [
    { role: "user", clientId: user.clientId, content: user.content, attachmentIds: user.attachmentIds, ...submitted },
    { role: "assistant", clientId: completion.assistantClientId, content: completion.finalAnswer, ...submitted,
      answerKind: "legal", citations: result.citations, citationClaim: result.citationClaim },
  ] };
const saved = verified ? await appendMessagesForJobPrincipal(ctx, appendInput, verified)
  : await ctx.runMutation(appendRef, appendInput);
if (saved.id !== completion.externalId) invalid();
const assistant = await ctx.db.query("messages").withIndex("by_session_clientId", q =>
  q.eq("sessionId", session._id).eq("clientId", completion.assistantClientId)).unique();
if (!assistant || assistant.role !== "assistant" || assistant.content !== completion.finalAnswer) invalid();
// This provenance is derived from the proof-bound completion in the same
// transaction as the answer. Public appendMessages accepts no such field.
await ctx.db.patch(assistant._id, { reviewedOriginalSource: {
  jurisdictionId: source.jurisdictionId, resourceId: source.resourceId, versionId: source.versionId,
  expectedSha256: source.expectedSha256, expectedByteSize: source.expectedByteSize,
  pageNumbers: completion.citations.map(citation => citation.pageNumber!),
} });
// Kept for the existing response protocol; append already consumed this claim.
return { ...result, answerKind: "legal" as const, persisted: true as const };
}

/** Runs within the caller's proof-validated job mutation; errors escape so
 * answer, citation claim, telemetry and provenance writes all roll back. */
export async function commitReviewedEmploymentForJobPrincipal(
  ctx: MutationCtx, args: ReviewedEmploymentCommitInput & { serviceProof: string },
  principal: VerifiedReviewedEmploymentJobPrincipal,
  jobId?: Id<"reviewedEmploymentJobs">,
): Promise<ReviewedEmploymentCommitResult> {
  const verified = await revalidateReviewedEmploymentJobPrincipal(ctx, principal,
    { externalId: args.completion.externalId, jurisdictionId: args.source.jurisdictionId });
  // Only the worker supplies this private ID, from its proof-validated job row.
  // Re-read it rather than accepting a timestamp from the request or worker body.
  let jobCreatedAt: number | undefined;
  if (jobId !== undefined) {
    const job = await ctx.db.get("reviewedEmploymentJobs", jobId);
    if (!job || job.ownerId !== verified.ownerId || job.nativeAuthSessionId !== verified.nativeAuthSessionId
      || job.sessionId !== verified.sessionId || job.externalId !== verified.externalId
      || job.jurisdictionId !== verified.jurisdictionId || job.userClientId !== args.user.clientId
      || job.assistantClientId !== args.completion.assistantClientId || job.status !== "running"
      || !Number.isSafeInteger(job.createdAt) || job.createdAt < 0 || job.createdAt > Date.now()) invalid();
    jobCreatedAt = job.createdAt;
  }
  return await commitHandler(ctx, args, verified, jobCreatedAt);
}

export const commit = mutation({
  args: { completion: completionValidator, source: sourceValidator, user: userValidator, serviceProof: v.string() },
  returns: v.object({ status: v.literal("completed"), outcome: v.literal("success"), answerKind: v.literal("legal"),
    citations: v.array(chatCitationValidator), partialCoverage: v.boolean(), citationClaim: v.string(), expiresAt: v.number(), persisted: v.literal(true) }),
  handler: commitHandler,
});
