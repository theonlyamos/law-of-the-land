import { httpRouter, makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { authComponent, createAuth } from "./auth";
import { hashCallbackToken } from "./admin/jobs";
import { authorizeFixtureRequest } from "./admin/e2eFixtures";
import { polar } from "./polar";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth);

// Polar webhooks at /polar/events keep subscription data in sync.
polar.registerRoutes(http);

const MAX_GROUNDX_CALLBACK_BYTES = 16_384;
const MAX_EXPORT_REFERENCE_BYTES = 256;
const MAX_SEARCH_JURISDICTION_BYTES = 64;
const MAX_SEARCH_JURISDICTIONS_BYTES = 1_024;
const MAX_JURISDICTION_ID_LENGTH = 128;
const completeGroundxCallback = makeFunctionReference<"mutation">(
  "admin/jobs:completeGroundxCallback",
);
const claimConversationExportReference = makeFunctionReference<"mutation">(
  "admin/exports:claimConversationExportReference",
);
const bootstrapE2eFixtures = makeFunctionReference<"action">("admin/e2eFixtures:bootstrap");
const cleanupE2eFixtures = makeFunctionReference<"mutation">("admin/e2eFixtures:cleanup");
const controlE2eFixtures = makeFunctionReference<"action">("admin/e2eFixtures:control");
const getSearchJurisdiction = internal.jurisdictions.getPublicByCode;
const getProductionLibraryAvailability = makeFunctionReference<"query">(
  "jurisdictions:getProductionLibraryAvailability",
);

async function secretsMatch(left: string, right: string) {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function authorizeSearchJurisdictionRequest(request: Request) {
  const configured = process.env.SEARCH_JURISDICTION_SECRET;
  const supplied = request.headers.get("x-search-jurisdiction-secret") ?? "";
  if (!configured || configured.length < 32 || supplied.length < 32) return false;
  return secretsMatch(configured, supplied);
}

async function readSearchJurisdictionCode(request: Request) {
  const bytes = await readBoundedBody(request, MAX_SEARCH_JURISDICTION_BYTES);
  if (!bytes) return null;
  try {
    const code = (JSON.parse(new TextDecoder().decode(bytes)) as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Z]{2}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

http.route({
  path: "/internal/search-jurisdiction",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await authorizeSearchJurisdictionRequest(request))) {
      return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    }
    const code = await readSearchJurisdictionCode(request);
    if (!code) return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });
    const jurisdiction = await ctx.runQuery(getSearchJurisdiction, { code });
    return Response.json(jurisdiction, {
      headers: { "cache-control": "no-store, private", "x-content-type-options": "nosniff" },
    });
  }),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_JURISDICTION_ID_LENGTH
  );
}

async function readProductionLibraryRequest(request: Request) {
  const bytes = await readBoundedBody(request, MAX_SEARCH_JURISDICTIONS_BYTES);
  if (!bytes || bytes.byteLength === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const keys = Object.keys(parsed);
  if (
    keys.length !== 2 ||
    !keys.includes("selectedJurisdictionId") ||
    !keys.includes("supplementaryJurisdictionIds") ||
    !boundedOpaqueId(parsed.selectedJurisdictionId) ||
    !Array.isArray(parsed.supplementaryJurisdictionIds) ||
    parsed.supplementaryJurisdictionIds.length > 3 ||
    !parsed.supplementaryJurisdictionIds.every(boundedOpaqueId)
  ) {
    return null;
  }
  const supplementaryJurisdictionIds = parsed.supplementaryJurisdictionIds as string[];
  const ids = [parsed.selectedJurisdictionId, ...supplementaryJurisdictionIds];
  if (new Set(ids).size !== ids.length) return null;
  return {
    selectedJurisdictionId: parsed.selectedJurisdictionId,
    supplementaryJurisdictionIds,
  };
}

type ProductionLibraryRequest = {
  selectedJurisdictionId: string;
  supplementaryJurisdictionIds: string[];
};

export async function productionLibraryResolutionResponse(
  runQuery: (input: ProductionLibraryRequest) => Promise<unknown>,
  input: ProductionLibraryRequest,
): Promise<Response> {
  try {
    const resolution = await runQuery(input);
    return Response.json(resolution, {
      headers: {
        "cache-control": "no-store, private",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const code = error instanceof ConvexError ? error.message : null;
    const status = code === "PRODUCTION_LIBRARY_REQUEST_INVALID"
      ? 400
      : code === "PRODUCTION_LIBRARY_NOT_FOUND"
        ? 404
        : 500;
    return new Response(null, {
      status,
      headers: { "cache-control": "no-store" },
    });
  }
}

http.route({
  path: "/internal/search-jurisdictions",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await authorizeSearchJurisdictionRequest(request))) {
      return new Response(null, {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    }
    const input = await readProductionLibraryRequest(request);
    if (!input) {
      return new Response(null, {
        status: 400,
        headers: { "cache-control": "no-store" },
      });
    }
    return await productionLibraryResolutionResponse(
      async (queryInput) =>
        await ctx.runQuery(getProductionLibraryAvailability, queryInput),
      input,
    );
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

async function readFixtureControl(request: Request) {
  const bytes = await readBoundedBody(request, 16_384);
  if (!bytes) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const operations = ["arm_provider_outcome", "expire_conversation_grant", "run_retention", "read_state", "prepare_matrix_operation", "read_matrix_operation", "deactivate_jurisdiction_member", "set_unified_jurisdictions_flag", "verify_place_claim"];
    if (typeof body.tag !== "string" || typeof body.operation !== "string" || !operations.includes(body.operation)) return null;
    if (body.operation === "verify_place_claim") {
      if (Object.keys(body).length !== 3 || typeof body.claim !== "string") return null;
      return { tag: body.tag, operation: body.operation, claim: body.claim };
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

http.route({
  path: "/groundx/callback",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
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
      typeof (body as Record<string, unknown>).callbackData !== "string" ||
      !/^gx_[a-f0-9]{64}$/.test(String((body as Record<string, unknown>).callbackData)) ||
      typeof (body as Record<string, unknown>).ingest !== "object" ||
      (body as Record<string, unknown>).ingest === null ||
      typeof ((body as Record<string, unknown>).ingest as Record<string, unknown>).processId !== "string" ||
      !["queued", "training", "processing", "complete", "error", "cancelled"].includes(String(((body as Record<string, unknown>).ingest as Record<string, unknown>).status))
    ) {
      return new Response(null, { status: 400 });
    }
    try {
      const token = (body as { callbackData: string }).callbackData;
      const ingest = (body as { ingest: { processId: string; status: "queued" | "training" | "processing" | "complete" | "error" | "cancelled" } }).ingest;
      const completed = (body as { ingest?: { progress?: { complete?: { documents?: Array<Record<string, unknown>> } } } }).ingest?.progress?.complete?.documents?.[0];
      await ctx.runMutation(completeGroundxCallback, {
        tokenHash: await hashCallbackToken(token),
        processId: ingest.processId,
        status: ingest.status,
        ...(completed && typeof completed.documentId === "string"
          ? { documentEvidence: {
              documentId: completed.documentId,
              status: ingest.status,
              ...(typeof completed.bucketId === "number" ? { bucketId: completed.bucketId } : {}),
            } }
          : {}),
      });
      return new Response(null, { status: 202 });
    } catch {
      return new Response(null, { status: 404 });
    }
  }),
});

export default http;
