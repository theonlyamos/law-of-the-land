import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { citationSourceUserId } from "./lib/citationSourceAccess";
import { authorizeCitationProvenance, canAccessSession } from "./chats";
import { citationFileProofValidators, validCitationFileProof } from "./lib/citationFileProof";

const argsValidator = { externalId: v.string(), messageId: v.id("messages"), citationIndex: v.number() };
const fileValidator = v.union(v.null(), v.object({ url: v.string(), filename: v.string(), mimeType: v.literal("application/pdf"), byteSize: v.number() }));
type SourceFile = { url: string; filename: string; mimeType: "application/pdf"; byteSize: number };
const resolveRef = makeFunctionReference<"query">("chatSources:resolveCitationFileInternal");

// An uncached action rechecks native login expiration before entering the
// atomic read which rechecks the owner, source permissions and stored PDF.
export const resolveCitationFile = action({
  args: { ...argsValidator, ...citationFileProofValidators }, returns: fileValidator,
  handler: async (ctx, args): Promise<SourceFile | null> => {
    if (!(await validCitationFileProof(args)) || !(await citationSourceUserId(ctx))) return null;
    return await ctx.runQuery(resolveRef, { externalId: args.externalId, messageId: args.messageId, citationIndex: args.citationIndex });
  },
});

export const resolveCitationFileInternal = internalQuery({
  args: argsValidator, returns: fileValidator,
  handler: async (ctx, args): Promise<SourceFile | null> => {
    if (!args.externalId.trim() || args.externalId !== args.externalId.trim() || args.externalId.length > 200
      || !Number.isSafeInteger(args.citationIndex) || args.citationIndex < 0 || args.citationIndex > 15) return null;
    try {
      const userId = await citationSourceUserId(ctx);
      if (!userId) return null;
      const session = await ctx.db.query("chatSessions").withIndex("by_user_externalId", q =>
        q.eq("userId", userId).eq("externalId", args.externalId)).unique();
      if (!session || !(await canAccessSession(ctx, session))) return null;
      const message = await ctx.db.get(args.messageId);
      // Reviewed answers retain their stricter pinned edition/date/page policy;
      // the route may fall back to the unchanged reviewed resolver for them.
      if (!message || message.reviewedOriginalSource) return null;
      return await authorizeCitationProvenance(ctx, session, message, args.citationIndex);
    } catch { return null; }
  },
});
