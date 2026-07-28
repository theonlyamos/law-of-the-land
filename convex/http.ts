import { httpRouter, makeFunctionReference } from "convex/server";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { hashCallbackToken } from "./admin/jobs";
import { polar } from "./polar";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth);

// Polar webhooks at /polar/events keep subscription data in sync.
polar.registerRoutes(http);

const MAX_GROUNDX_CALLBACK_BYTES = 16_384;
const MAX_EXPORT_REFERENCE_BYTES = 256;
const completeGroundxCallback = makeFunctionReference<"mutation">(
  "admin/jobs:completeGroundxCallback",
);
const claimConversationExportReference = makeFunctionReference<"mutation">(
  "admin/exports:claimConversationExportReference",
);

http.route({
  path: "/admin/export-download",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const bytes = await readBoundedBody(request, MAX_EXPORT_REFERENCE_BYTES);
    if (!bytes || bytes.byteLength === 0) return new Response(null, { status: 400 });
    let reference = "";
    try { reference = String((JSON.parse(new TextDecoder().decode(bytes)) as { reference?: unknown }).reference ?? ""); } catch { return new Response(null, { status: 400 }); }
    if (!/^exp_[A-Za-z0-9_-]{64}$/.test(reference)) return new Response(null, { status: 404 });
    try {
      const claim: { storageId: import("./_generated/dataModel").Id<"_storage">; expiresAt: number } = await ctx.runMutation(claimConversationExportReference, { reference });
      const blob = await ctx.storage.get(claim.storageId);
      if (!blob) return new Response(null, { status: 404 });
      return new Response(blob.stream(), { status: 200, headers: { "content-type": "application/x-ndjson", "content-disposition": "attachment; filename=\"conversation-export.ndjson\"", "cache-control": "no-store, private", "x-content-type-options": "nosniff", "content-length": String(blob.size) } });
    } catch { return new Response(null, { status: 404, headers: { "cache-control": "no-store" } }); }
  }),
});

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declaredSize = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

http.route({
  pathPrefix: "/groundx/callback/",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const token = new URL(request.url).pathname.slice("/groundx/callback/".length);
    if (!/^gx_[a-f0-9]{64}$/.test(token)) {
      return new Response(null, { status: 404 });
    }
    const declaredSize = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredSize) && declaredSize > MAX_GROUNDX_CALLBACK_BYTES) {
      return new Response(null, { status: 400 });
    }
    const bytes = await readBoundedBody(request, MAX_GROUNDX_CALLBACK_BYTES);
    if (!bytes) {
      return new Response(null, { status: 400 });
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return new Response(null, { status: 400 });
    }
    if (
      typeof body !== "object" || body === null ||
      typeof (body as Record<string, unknown>).processId !== "string" ||
      typeof (body as Record<string, unknown>).targetType !== "string" ||
      typeof (body as Record<string, unknown>).targetId !== "string" ||
      !["complete", "error", "cancelled"].includes(String((body as Record<string, unknown>).status))
    ) {
      return new Response(null, { status: 400 });
    }
    try {
      await ctx.runMutation(completeGroundxCallback, {
        tokenHash: await hashCallbackToken(token),
        processId: (body as { processId: string }).processId,
        targetType: (body as { targetType: string }).targetType,
        targetId: (body as { targetId: string }).targetId,
        status: (body as { status: "complete" | "error" | "cancelled" }).status,
      });
      return new Response(null, { status: 202 });
    } catch {
      return new Response(null, { status: 404 });
    }
  }),
});

export default http;
