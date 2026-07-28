import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";

const getPageRef = makeFunctionReference<"query">("admin/exports:getConversationExportPage");
const finalizeRef = makeFunctionReference<"mutation">("admin/exports:finalizeConversationExport");
const failRef = makeFunctionReference<"mutation">("admin/exports:failConversationExport");
const MAX_EXPORT_BYTES = 5 * 1024 * 1024;
const MAX_EXPORT_PAGES = 100;

type ExportPage = { correlationId: string; page: Array<{ role: "user" | "assistant"; content: string; createdAt: number }>; isDone: boolean; continueCursor: string };

export const buildConversationExport = internalAction({
  args: { exportId: v.id("adminExports") },
  returns: v.null(),
  handler: async (ctx, args) => {
    let storedId: Id<"_storage"> | null = null;
    try {
      let cursor: string | null = null;
      let correlationId = "";
      const lines: string[] = [];
      let bytes = 0;
      for (let pageNumber = 0; pageNumber < MAX_EXPORT_PAGES; pageNumber += 1) {
        const result: ExportPage = await ctx.runQuery(getPageRef, { exportId: args.exportId, paginationOpts: { numItems: 100, cursor } });
        correlationId = result.correlationId;
        for (const message of result.page) {
          const line = `${JSON.stringify(message)}\n`;
          bytes += new TextEncoder().encode(line).byteLength;
          if (bytes > MAX_EXPORT_BYTES) throw new Error("export size limit exceeded");
          lines.push(line);
        }
        if (result.isDone) {
          storedId = await ctx.storage.store(new Blob(lines, { type: "application/x-ndjson" }));
          await ctx.runMutation(finalizeRef, { correlationId, storageId: storedId });
          storedId = null;
          return null;
        }
        cursor = result.continueCursor;
      }
      throw new Error("export page limit exceeded");
    } catch {
      if (storedId) await ctx.storage.delete(storedId);
      await ctx.runMutation(failRef, { exportId: args.exportId });
      return null;
    }
  },
});
