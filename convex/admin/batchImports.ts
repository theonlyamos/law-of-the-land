import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type QueryCtx } from "../_generated/server";
import { writeAudit } from "./audit";
import { createDocumentVersionForActor, uploadLimit, verifyStoredOriginal } from "./documents";
import { requireEnabledAdminCatalogRead, requireEnabledAdminPermission } from "./featureFlags";
import { createResourceForActor } from "./resources";
import { batchIdentityKey as identityKey } from "../../shared/batch-identity";

const entryValidator = v.object({
  filename: v.string(), title: v.string(), issuer: v.string(), officialCitation: v.string(),
  sourceUrl: v.string(), topics: v.array(v.string()), effectiveDate: v.optional(v.string()),
  sourceProvenance: v.string(), caseAliases: v.array(v.string()),
});
const importArgs = {
  jurisdictionId: v.id("jurisdictions"), entry: entryValidator, sha256: v.string(), byteSize: v.number(),
};
const resultValidator = v.object({
  kind: v.union(v.literal("new"), v.literal("imported"), v.literal("existing"), v.literal("conflict")),
  message: v.string(), resourceId: v.optional(v.id("legalResources")),
  versionId: v.optional(v.id("documentVersions")), status: v.optional(v.string()), indexed: v.boolean(),
});
type Entry = Infer<typeof entryValidator>;
type Result = Infer<typeof resultValidator>;
type Input = { jurisdictionId: Id<"jurisdictions">; entry: Entry; sha256: string; byteSize: number };
const PREPARATION_PAGE_SIZE = 100;

function validateInput(args: Input): Input {
  const entry = { ...args.entry };
  for (const field of ["title", "issuer", "officialCitation"] as const) {
    entry[field] = entry[field].trim();
    if (!entry[field] || entry[field].length > 300 || !identityKey(entry[field])) {
      throw new ConvexError("INVALID_BATCH_METADATA");
    }
  }
  entry.filename = entry.filename.trim().normalize("NFKC");
  if (!/^.+\.pdf$/i.test(entry.filename) || entry.filename.length > 180 || /[\\/\u0000-\u001f\u007f]/.test(entry.filename)) {
    throw new ConvexError("INVALID_DOCUMENT_FILENAME");
  }
  if (!Number.isSafeInteger(args.byteSize) || args.byteSize < 1) throw new ConvexError("INVALID_DOCUMENT_SIZE");
  if (args.byteSize > uploadLimit()) throw new ConvexError("DOCUMENT_TOO_LARGE");
  const sha256 = args.sha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new ConvexError("INVALID_DOCUMENT_CHECKSUM");
  let source: URL;
  try { source = new URL(entry.sourceUrl); } catch { throw new ConvexError("INVALID_SOURCE_URL"); }
  if (entry.sourceUrl.length > 500 || source.protocol !== "https:" || source.username || source.password) {
    throw new ConvexError("INVALID_SOURCE_URL");
  }
  entry.sourceUrl = source.toString();
  entry.sourceProvenance = entry.sourceProvenance.trim();
  if (!entry.sourceProvenance || entry.sourceProvenance.length > 2000) throw new ConvexError("INVALID_SOURCE_PROVENANCE");
  if (entry.caseAliases.length > 25) throw new ConvexError("TOO_MANY_CASE_ALIASES");
  entry.caseAliases = entry.caseAliases.map(alias => alias.trim());
  if (entry.caseAliases.some(alias => !identityKey(alias) || alias.length > 300)) throw new ConvexError("INVALID_CASE_ALIAS");
  if (entry.topics.length > 8 || entry.topics.some(topic => !topic.trim() || topic.trim().length > 80)) throw new ConvexError("INVALID_TOPICS");
  entry.topics = entry.topics.map(topic => topic.trim());
  if (new Set(entry.topics.map(topic => topic.toLowerCase())).size !== entry.topics.length) throw new ConvexError("INVALID_TOPICS");
  if (entry.effectiveDate !== undefined && entry.effectiveDate !== "") {
    const date = new Date(`${entry.effectiveDate}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.effectiveDate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== entry.effectiveDate) {
      throw new ConvexError("INVALID_EFFECTIVE_DATE");
    }
  }
  return { ...args, entry, sha256 };
}

function versionResult(kind: "existing" | "imported", version: Doc<"documentVersions">): Result {
  return { kind, message: kind === "imported" ? "Original saved. Individual review is required." : "Identical original already exists. Existing metadata and review remain unchanged.",
    resourceId: version.resourceId, versionId: version._id, status: version.status,
    indexed: version.status === "published" && version.geminiIndexedAt !== undefined && version.geminiDocumentName !== undefined };
}

async function inspect(ctx: QueryCtx, args: Input): Promise<Result> {
  const jurisdiction = await ctx.db.get(args.jurisdictionId);
  if (!jurisdiction || jurisdiction.status !== "enabled") throw new ConvexError("JURISDICTION_NOT_ENABLED");
  const hashes = await ctx.db.query("documentVersions").withIndex("by_sha256", q => q.eq("sha256", args.sha256)).take(2);
  if (hashes.length > 1) return { kind: "conflict", message: "Multiple existing records match this original. Resolve duplicates individually.", indexed: false };
  const unpreparedTitle = await ctx.db.query("legalResources").withIndex("by_jurisdictionId_and_batchTitleKey", q =>
    q.eq("jurisdictionId", args.jurisdictionId).eq("batchTitleKey", undefined)).take(1);
  const unpreparedCitation = await ctx.db.query("legalResources").withIndex("by_jurisdictionId_and_batchCitationKey", q =>
    q.eq("jurisdictionId", args.jurisdictionId).eq("batchCitationKey", undefined)).take(1);
  if (unpreparedTitle.length || unpreparedCitation.length) {
    return { kind: "conflict", message: "Prepare catalog duplicate checks before importing.", indexed: false };
  }
  const values = [...new Set([args.entry.title, args.entry.officialCitation, ...args.entry.caseAliases])];
  const keys = new Set(values.map(identityKey));
  const resources = new Map<string, Doc<"legalResources">>();
  for (const key of keys) {
    const registered = await ctx.db.query("batchImportIdentities")
      .withIndex("by_jurisdictionId_and_key", q => q.eq("jurisdictionId", args.jurisdictionId).eq("key", key)).take(2);
    if (registered.length > 1) return { kind: "conflict", message: "Ambiguous case identity. Resolve existing records before importing.", indexed: false };
    for (const row of registered) {
      const resource = await ctx.db.get(row.resourceId);
      if (!resource || resource.jurisdictionId !== args.jurisdictionId) return { kind: "conflict", message: "Case identity points to a missing or inconsistent resource. Resolve before importing.", indexed: false };
      resources.set(resource._id, resource);
    }
    const titles = await ctx.db.query("legalResources").withIndex("by_jurisdictionId_and_batchTitleKey", q =>
      q.eq("jurisdictionId", args.jurisdictionId).eq("batchTitleKey", key)).take(2);
    const citations = await ctx.db.query("legalResources").withIndex("by_jurisdictionId_and_batchCitationKey", q =>
      q.eq("jurisdictionId", args.jurisdictionId).eq("batchCitationKey", key)).take(2);
    for (const resource of [...titles, ...citations]) resources.set(resource._id, resource);
    if (resources.size > 1) return { kind: "conflict", message: "Multiple existing records match this case identity. Resolve duplicates individually.", indexed: false };
  }
  if (hashes[0]) {
    const resource = await ctx.db.get(hashes[0].resourceId);
    if (!resource || resource.jurisdictionId !== args.jurisdictionId || resource.type !== "judgment" || (resources.size && !resources.has(resource._id))) {
      return { kind: "conflict", message: "These bytes already belong to a different resource or jurisdiction. Review the existing original individually.", indexed: false };
    }
    return versionResult("existing", hashes[0]);
  }
  const matching = [...resources.values()][0];
  if (matching) return { kind: "conflict", message: "Case citation or alias already exists with different or missing bytes. Review the existing resource before adding a version.", resourceId: matching._id, indexed: false };
  return { kind: "new", message: "No matching original or case identity found. Ready to upload for review.", indexed: false };
}

export const prepareDuplicateChecks = mutation({
  args: { jurisdictionId: v.id("jurisdictions") },
  returns: v.object({ processed: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const actor = await requireEnabledAdminPermission(ctx, "resource", "write");
    await requireEnabledAdminPermission(ctx, "document", "write");
    const jurisdiction = await ctx.db.get(args.jurisdictionId);
    if (!jurisdiction || jurisdiction.status !== "enabled") throw new ConvexError("JURISDICTION_NOT_ENABLED");
    const titles = await ctx.db.query("legalResources").withIndex("by_jurisdictionId_and_batchTitleKey", q =>
      q.eq("jurisdictionId", args.jurisdictionId).eq("batchTitleKey", undefined)).take(PREPARATION_PAGE_SIZE);
    for (const resource of titles) {
      await ctx.db.patch(resource._id, { batchTitleKey: identityKey(resource.title), batchCitationKey: identityKey(resource.officialCitation) });
    }
    // Also finish rows from a partially completed metadata migration, within the same page budget.
    const citations = titles.length < PREPARATION_PAGE_SIZE
      ? await ctx.db.query("legalResources").withIndex("by_jurisdictionId_and_batchCitationKey", q =>
        q.eq("jurisdictionId", args.jurisdictionId).eq("batchCitationKey", undefined)).take(PREPARATION_PAGE_SIZE - titles.length)
      : [];
    for (const resource of citations) {
      await ctx.db.patch(resource._id, { batchTitleKey: identityKey(resource.title), batchCitationKey: identityKey(resource.officialCitation) });
    }
    const processed = titles.length + citations.length;
    const remainingTitle = await ctx.db.query("legalResources").withIndex("by_jurisdictionId_and_batchTitleKey", q =>
      q.eq("jurisdictionId", args.jurisdictionId).eq("batchTitleKey", undefined)).take(1);
    const remainingCitation = await ctx.db.query("legalResources").withIndex("by_jurisdictionId_and_batchCitationKey", q =>
      q.eq("jurisdictionId", args.jurisdictionId).eq("batchCitationKey", undefined)).take(1);
    if (processed) await writeAudit(ctx, { actorId: actor.userId, actorRoles: actor.roles,
      action: "resource.batch_duplicate_checks_prepared", targetType: "jurisdiction", targetId: args.jurisdictionId,
      reason: "Prepare exact catalog duplicate checks", afterSummary: JSON.stringify({ processed }), outcome: "success" });
    return { processed, done: !remainingTitle.length && !remainingCitation.length };
  },
});

export const preflight = query({
  args: importArgs, returns: resultValidator,
  handler: async (ctx, raw) => {
    await requireEnabledAdminPermission(ctx, "resource", "write");
    await requireEnabledAdminPermission(ctx, "document", "write");
    return inspect(ctx, validateInput(raw));
  },
});

export const commit = mutation({
  args: { ...importArgs, storageId: v.id("_storage") }, returns: resultValidator,
  handler: async (ctx, raw) => {
    const actor = await requireEnabledAdminPermission(ctx, "resource", "write");
    await requireEnabledAdminPermission(ctx, "document", "write");
    const args = validateInput(raw);
    await verifyStoredOriginal(ctx, { storageId: raw.storageId, byteSize: args.byteSize, sha256: args.sha256, mimeType: "application/pdf" });
    const duplicate = await inspect(ctx, args);
    if (duplicate.kind !== "new") return duplicate;
    const { entry } = args;
    const resourceId = await createResourceForActor(ctx, actor, {
      jurisdictionId: args.jurisdictionId, type: "judgment", title: entry.title, issuer: entry.issuer,
      officialCitation: entry.officialCitation, sourceUrl: entry.sourceUrl, topics: entry.topics,
      effectiveDate: entry.effectiveDate, reason: "Import manifest judgment for individual review",
    });
    const versionId = await createDocumentVersionForActor(ctx, actor, {
      resourceId, storageId: raw.storageId, filename: entry.filename, mimeType: "application/pdf",
      byteSize: args.byteSize, sha256: args.sha256, sourceUrl: entry.sourceUrl, effectiveAt: entry.effectiveDate,
    });
    await ctx.db.insert("batchImportEvidence", {
      jurisdictionId: args.jurisdictionId, resourceId, versionId, sourceUrl: entry.sourceUrl,
      sourceProvenance: entry.sourceProvenance, caseAliases: entry.caseAliases,
      importedBy: actor.userId, createdAt: Date.now(),
    });
    for (const key of new Set([entry.title, entry.officialCitation, ...entry.caseAliases].map(identityKey))) {
      await ctx.db.insert("batchImportIdentities", { jurisdictionId: args.jurisdictionId, resourceId, key });
    }
    await writeAudit(ctx, { actorId: actor.userId, actorRoles: actor.roles, action: "document.batch_imported",
      targetType: "documentVersion", targetId: versionId, reason: "Preserve import provenance for individual review",
      afterSummary: JSON.stringify({ resourceId, aliasCount: entry.caseAliases.length, status: "ready_for_review" }), outcome: "success" });
    const version = await ctx.db.get(versionId);
    if (!version) throw new ConvexError("DOCUMENT_VERSION_NOT_FOUND");
    return versionResult("imported", version);
  },
});

export const getStatus = query({
  args: { versionId: v.id("documentVersions") },
  returns: v.object({ ...resultValidator.fields, sourceProvenance: v.optional(v.string()), sourceUrl: v.optional(v.string()), caseAliases: v.optional(v.array(v.string())), failureSummary: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    await requireEnabledAdminCatalogRead(ctx, "document");
    const version = await ctx.db.get(args.versionId);
    if (!version) throw new ConvexError("DOCUMENT_VERSION_NOT_FOUND");
    const evidence = await ctx.db.query("batchImportEvidence").withIndex("by_versionId", q => q.eq("versionId", version._id)).unique();
    return { ...versionResult("existing", version), sourceUrl: evidence?.sourceUrl ?? version.sourceUrl,
      ...(evidence ? { sourceProvenance: evidence.sourceProvenance, caseAliases: evidence.caseAliases } : {}),
      ...(version.failureSummary ? { failureSummary: version.failureSummary } : {}) };
  },
});
