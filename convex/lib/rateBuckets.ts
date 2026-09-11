import type { MutationCtx } from "../_generated/server";
export async function consumeRateBucket(
  ctx: MutationCtx,
  namespace: string,
  key: string,
  limit: number,
  windowMs = 60_000,
): Promise<number> {
  const now = Date.now(),
    window = Math.floor(now / windowMs);
  const row = await ctx.db
    .query("widgetRateBuckets")
    .withIndex("by_namespace_and_key_and_window", (q) =>
      q.eq("namespace", namespace).eq("key", key).eq("window", window),
    )
    .unique();
  const expiresAt = (window + 1) * windowMs;
  if (row)
    await ctx.db.patch(row._id, { count: Math.min(row.count + 1, limit + 1) });
  else
    await ctx.db.insert("widgetRateBuckets", {
      namespace,
      key,
      window,
      count: 1,
      expiresAt,
    });
  return (row?.count ?? 0) >= limit ? Math.ceil((expiresAt - now) / 1000) : 0;
}
