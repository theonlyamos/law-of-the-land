import { httpRouter, makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { authorizeFixtureRequest } from "./admin/e2eFixtures";
import { polar } from "./polar";
import type { ChatResearchStores } from "./jurisdictions";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth);

// Polar webhooks at /polar/events keep subscription data in sync.
polar.registerRoutes(http);

const MAX_EXPORT_REFERENCE_BYTES = 256;
const MAX_CHAT_RESEARCH_MANIFEST_BYTES = 256;
const MAX_JURISDICTION_ID_LENGTH = 128;
const claimConversationExportReference = makeFunctionReference<"mutation">(
  "admin/exports:claimConversationExportReference",
);
const bootstrapE2eFixtures = makeFunctionReference<"action">("admin/e2eFixtures:bootstrap");
const cleanupE2eFixtures = makeFunctionReference<"mutation">("admin/e2eFixtures:cleanup");
const controlE2eFixtures = makeFunctionReference<"action">("admin/e2eFixtures:control");
const resolveChatResearchStores = makeFunctionReference<"query">(
  "jurisdictions:resolveChatResearchStores",
);

function noStore(status: number): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

function readChatResearchManifestRequest(bytes: Uint8Array): { jurisdictionId: string } | null {
  if (bytes.byteLength === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1
    || typeof record.jurisdictionId !== "string"
    || record.jurisdictionId.length === 0
    || record.jurisdictionId.length > MAX_JURISDICTION_ID_LENGTH
    || record.jurisdictionId !== record.jurisdictionId.trim()
  ) return null;
  return { jurisdictionId: record.jurisdictionId };
}

http.route({
  path: "/private/chat-research-manifest",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!await ctx.auth.getUserIdentity()) return noStore(401);
    const bytes = await readBoundedBody(request, MAX_CHAT_RESEARCH_MANIFEST_BYTES);
    if (!bytes) return noStore(400);
    const input = readChatResearchManifestRequest(bytes);
    if (!input) return noStore(400);
    try {
      const resolution: ChatResearchStores = await ctx.runQuery(resolveChatResearchStores, input);
      return Response.json(resolution, {
        headers: {
          "cache-control": "no-store, private",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      const code = error instanceof ConvexError ? error.message : null;
      if (code === "JURISDICTION_ACCESS_DENIED" || code === "JURISDICTION_SCOPE_STATE_INVALID") {
        return noStore(404);
      }
      if (code === "CHAT_RESEARCH_STORE_NOT_READY") return noStore(503);
      return noStore(500);
    }
  }),
});

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

async function readFixtureTag(request: Request) {
  const bytes = await readBoundedBody(request, 256);
  if (!bytes) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as { tag?: unknown };
    return typeof body.tag === "string" ? body.tag : null;
  } catch { return null; }
}

export async function readFixtureControl(request: Request) {
  const bytes = await readBoundedBody(request, 16_384);
  if (!bytes) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const operations = ["arm_provider_outcome", "expire_conversation_grant", "run_retention", "read_state", "prepare_matrix_operation", "read_matrix_operation", "deactivate_jurisdiction_member", "set_unified_jurisdictions_flag", "verify_place_claim", "verify_telemetry_ingest_secret"];
    if (typeof body.tag !== "string" || typeof body.operation !== "string" || !operations.includes(body.operation)) return null;
    if (body.operation === "verify_place_claim") {
      if (Object.keys(body).length !== 3 || typeof body.claim !== "string") return null;
      return { tag: body.tag, operation: body.operation, claim: body.claim };
    }
    if (body.operation === "verify_telemetry_ingest_secret") {
      if (Object.keys(body).length !== 3 || typeof body.proof !== "string") return null;
      return { tag: body.tag, operation: body.operation, proof: body.proof };
    }
    if (body.operation === "deactivate_jurisdiction_member") {
      if (Object.keys(body).length !== 3 || typeof body.membershipId !== "string") return null;
      return { tag: body.tag, operation: body.operation, membershipId: body.membershipId };
    }
    if (body.operation === "set_unified_jurisdictions_flag") {
      if (Object.keys(body).length !== 3 || typeof body.enabled !== "boolean") return null;
      return { tag: body.tag, operation: body.operation, enabled: body.enabled };
    }
    return {
      tag: body.tag,
      operation: body.operation as "arm_provider_outcome" | "expire_conversation_grant" | "run_retention" | "read_state" | "prepare_matrix_operation" | "read_matrix_operation",
      ...(typeof body.versionId === "string" ? { versionId: body.versionId } : {}),
      ...(typeof body.path === "string" ? { path: body.path } : {}),
      ...(typeof body.role === "string" ? { role: body.role } : {}),
      ...(typeof body.key === "string" ? { key: body.key } : {}),
      ...(typeof body.publicationOperation === "string" ? { publicationOperation: body.publicationOperation } : {}),
      ...(typeof body.providerOutcome === "string" ? { providerOutcome: body.providerOutcome } : {}),
      ...(body.payload !== undefined ? { payload: body.payload } : {}),
    };
  } catch { return null; }
}

http.route({
  path: "/admin/e2e-fixtures/bootstrap",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await authorizeFixtureRequest(request))) return new Response(null, { status: 404 });
    const tag = await readFixtureTag(request);
    if (!tag) return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });
    try {
      const result = await ctx.runAction(bootstrapE2eFixtures, { tag });
      return Response.json(result, { status: 201, headers: { "cache-control": "no-store, private", pragma: "no-cache" } });
    } catch {
      return Response.json({ error: "Fixture bootstrap refused" }, { status: 409, headers: { "cache-control": "no-store" } });
    }
  }),
});

http.route({
  path: "/admin/e2e-fixtures/cleanup",
  method: "DELETE",
  handler: httpAction(async (ctx, request) => {
    if (!(await authorizeFixtureRequest(request))) return new Response(null, { status: 404 });
    const tag = await readFixtureTag(request);
    if (!tag) return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });
    try {
      const result = await ctx.runMutation(cleanupE2eFixtures, { tag });
      return Response.json(result, { status: 200, headers: { "cache-control": "no-store, private", pragma: "no-cache" } });
    } catch {
      return Response.json({ error: "Fixture cleanup refused" }, { status: 409, headers: { "cache-control": "no-store" } });
    }
  }),
});

http.route({
  path: "/admin/e2e-fixtures/control",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await authorizeFixtureRequest(request))) return new Response(null, { status: 404 });
    const input = await readFixtureControl(request);
    if (!input) return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });
    try {
      const result = await ctx.runAction(controlE2eFixtures, input);
      return Response.json(result, { status: 200, headers: { "cache-control": "no-store, private", pragma: "no-cache" } });
    } catch {
      return Response.json({ error: "Fixture control refused" }, { status: 409, headers: { "cache-control": "no-store" } });
    }
  }),
});

export default http;
