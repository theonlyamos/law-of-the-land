import { makeFunctionReference } from "convex/server";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthAction, getToken } from "@/lib/auth-server";
import { createTelemetryServiceProof } from "@/convex/lib/telemetryProof";
import { DOCUMENT_DRAFT_LIMITS, documentDraftSourceProofParts } from "../../../../../../../../shared/document-draft";

export const runtime = "nodejs";
const privateHeaders = { "cache-control": "no-store, private", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
type SourceFile = { url: string; filename: string; mimeType: "application/pdf"; byteSize: number };
type Selector = { draftId: Id<"documentDrafts">; clauseId: Id<"documentDraftClauses">; citationIndex: number; expiresAt: number; serviceProof: string };
const resolveCitationFile = makeFunctionReference<"action", Selector, SourceFile | null>("documentDraftSources:resolveCitationFile");
type Context = { params: Promise<{ draftId: string; clauseId: string; citationIndex: string }> };
const ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** Streams the original law PDF behind one document-draft clause citation. */
export async function GET(request: Request, { params }: Context): Promise<Response> {
  try {
    const { draftId, clauseId, citationIndex } = await params;
    const index = Number(citationIndex);
    if (!ID.test(draftId) || !ID.test(clauseId) || !/^[0-9]$/u.test(citationIndex) || index >= DOCUMENT_DRAFT_LIMITS.maxCitationsPerClause
      || [...new URL(request.url).searchParams.keys()].length !== 0)
      return new Response("File not found.", { status: 404, headers: privateHeaders });
    if (!await getToken()) return new Response("Sign in to view this file.", { status: 401, headers: privateHeaders });
    const selector = { draftId: draftId as Id<"documentDrafts">, clauseId: clauseId as Id<"documentDraftClauses">, citationIndex: index, expiresAt: Date.now() + 60_000 };
    const file = await fetchAuthAction(resolveCitationFile, {
      ...selector, serviceProof: await createTelemetryServiceProof(documentDraftSourceProofParts(selector)),
    });
    if (!file) return new Response("File not found.", { status: 404, headers: privateHeaders });
    const url = new URL(file.url);
    const allowedOrigins = [process.env.NEXT_PUBLIC_CONVEX_URL, process.env.NEXT_PUBLIC_CONVEX_SITE_URL]
      .filter(Boolean).map(value => new URL(value!).origin);
    if (url.protocol !== "https:" || !allowedOrigins.includes(url.origin) || !url.pathname.startsWith("/api/storage/")
      || url.username || url.password || file.mimeType !== "application/pdf" || typeof file.filename !== "string"
      || file.filename.length > 500 || !Number.isSafeInteger(file.byteSize) || file.byteSize < 1 || file.byteSize > 32 * 1024 * 1024)
      throw new Error("Invalid original file response");
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
    const range = request.headers.get("range");
    const upstream = await fetch(file.url, { cache: "no-store", redirect: "error", signal,
      headers: range && /^bytes=(?:\d+-\d*|-\d+)$/u.test(range) ? { range } : {} });
    if (upstream.status !== 416 && (!upstream.ok || !upstream.body))
      return new Response("File viewing is unavailable.", { status: upstream.status === 404 ? 404 : 503, headers: privateHeaders });
    const headers = new Headers(privateHeaders);
    headers.set("content-type", "application/pdf");
    headers.set("content-security-policy", "sandbox; default-src 'none'");
    const filename = encodeURIComponent(file.filename).replace(/['()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    headers.set("content-disposition", `inline; filename*=UTF-8''${filename}`);
    for (const name of ["content-length", "content-range", "accept-ranges"]) {
      if (upstream.status === 416 && name === "content-length") continue;
      const value = upstream.headers.get(name); if (value) headers.set(name, value);
    }
    return new Response(upstream.status === 416 ? null : upstream.body, { status: upstream.status, headers });
  } catch { return new Response("File viewing is unavailable.", { status: 503, headers: privateHeaders }); }
}
