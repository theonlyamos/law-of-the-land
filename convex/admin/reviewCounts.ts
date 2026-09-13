import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "../_generated/server";

type Version = Omit<Doc<"documentVersions">, "_id" | "_creationTime" | "reviewCounted">;

export async function getReviewCountState(ctx: QueryCtx) {
  return await ctx.db.query("reviewStageCounts").withIndex("by_key", q => q.eq("key", "all")).unique();
}

async function countState(ctx: MutationCtx) {
  const existing = await getReviewCountState(ctx);
  if (existing) return existing;
  const id = await ctx.db.insert("reviewStageCounts", { key: "all", counts: {}, cursor: null, ready: false });
  return (await ctx.db.get(id))!;
}

// ponytail: one counter row serializes document writes; shard if upload throughput warrants it.
async function changeCount(ctx: MutationCtx, previous: string | undefined, next: string | undefined) {
  if (previous === next) return;
  const state = await countState(ctx);
  const counts = { ...state.counts };
  if (previous !== undefined) counts[previous] = (counts[previous] ?? 0) - 1;
  if (next !== undefined) counts[next] = (counts[next] ?? 0) + 1;
  await ctx.db.patch(state._id, { counts });
}

export async function insertDocumentVersion(ctx: MutationCtx, version: Version) {
  const id = await ctx.db.insert("documentVersions", { ...version, reviewCounted: true });
  await changeCount(ctx, undefined, version.status);
  return id;
}

export async function patchDocumentVersion(ctx: MutationCtx, id: Id<"documentVersions">, patch: Partial<Version> & Pick<Version, "status">) {
  const version = await ctx.db.get(id);
  if (!version) throw new ConvexError("DOCUMENT_VERSION_NOT_FOUND");
  await changeCount(ctx, version.reviewCounted ? version.status : undefined, patch.status);
  await ctx.db.patch(id, { ...patch, reviewCounted: true });
}

export async function deleteDocumentVersion(ctx: MutationCtx, id: Id<"documentVersions">) {
  const version = await ctx.db.get(id);
  if (version?.reviewCounted) await changeCount(ctx, version.status, undefined);
  await ctx.db.delete(id);
}

// Backfill runs once per deployment database; the marker prevents double counting
// when a lifecycle mutation touches an old version before its batch is reached.
export const backfill = internalMutation({
  args: {},
  returns: v.null(),
  handler: async ctx => {
    const state = await countState(ctx);
    if (state.ready) return null;
    const result = await ctx.db.query("documentVersions").order("asc").paginate({
      cursor: state.cursor, numItems: 200, maximumRowsRead: 200, maximumBytesRead: 1024 * 1024,
    });
    const counts = { ...state.counts };
    for (const version of result.page) {
      if (version.reviewCounted) continue;
      counts[version.status] = (counts[version.status] ?? 0) + 1;
      await ctx.db.patch(version._id, { reviewCounted: true });
    }
    await ctx.db.patch(state._id, { counts, cursor: result.continueCursor, ready: result.isDone });
    if (!result.isDone) await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation">("admin/reviewCounts:backfill"), {});
    return null;
  },
});
