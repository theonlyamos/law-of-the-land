import { v } from "convex/values";
import { query } from "./_generated/server";
import { countRows } from "./countRows";

export const countAuthTables = query({
  args: {},
  returns: v.object({
    user: v.number(),
    session: v.number(),
    account: v.number(),
    verification: v.number(),
  }),
  handler: async (ctx) => ({
    user: await countRows(ctx.db.query("user")),
    session: await countRows(ctx.db.query("session")),
    account: await countRows(ctx.db.query("account")),
    verification: await countRows(ctx.db.query("verification")),
  }),
});
