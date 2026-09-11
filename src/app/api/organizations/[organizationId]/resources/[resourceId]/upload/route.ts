import { organizationApi } from "@/lib/organization-api";
import type { Id } from "../../../../../../../../convex/_generated/dataModel";
import { createWidgetServiceProof, uploadProofBytes } from "../../../../../../../../convex/lib/widgetProof";
import { fetchAuthMutation } from "@/lib/auth-server";
import { applicationOrigin, readWidgetBody } from "@/lib/embed/server";

export async function POST(request: Request, context: { params: Promise<{ organizationId: string; resourceId: string }> }) {
  try {
    // Cookie-authenticated upload is same-origin; reject cross-site form submissions.
    if (request.headers.get("origin") !== applicationOrigin(request)) return Response.json({ error: "Upload must start from your organization workspace." }, { status: 403 });
    const { organizationId, resourceId } = await context.params;
    const prepared = await fetchAuthMutation(organizationApi.organizationContent.prepareUpload, { resourceId: resourceId as Id<"legalResources"> });
    if (prepared.organizationId !== organizationId) return Response.json({ error: "Organization access denied." }, { status: 403 });
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.startsWith("multipart/form-data;")) return Response.json({ error: "Choose a document to upload." }, { status: 400 });
    const bytes = await readWidgetBody(request, prepared.maximumBytes + 65536);
    const form = await new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": contentType } }).formData();
    if ([...form.keys()].some(key => !["file", "sourceUrl", "effectiveAt"].includes(key)) || [...form.keys()].length !== 3) throw new Error("INVALID_UPLOAD");
    const file = form.get("file");
    if (!(file instanceof File) || file.size < 1 || file.size > prepared.maximumBytes) throw new Error("BODY_TOO_LARGE");
    const sourceUrl = form.get("sourceUrl"), effectiveAt = form.get("effectiveAt");
    if (typeof sourceUrl !== "string" || typeof effectiveAt !== "string") throw new Error("INVALID_UPLOAD");
    const fileBytes = await file.arrayBuffer();
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", fileBytes))].map(b => b.toString(16).padStart(2, "0")).join("");
    const uploaded = await fetch(prepared.uploadUrl, { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: fileBytes, signal: AbortSignal.any([request.signal, AbortSignal.timeout(45000)]) });
    if (!uploaded.ok) throw new Error("UPLOAD_FAILED");
    const stored: unknown = await uploaded.json();
    if (!stored || typeof stored !== "object" || !("storageId" in stored) || typeof stored.storageId !== "string") throw new Error("UPLOAD_FAILED");
    const input = { resourceId: resourceId as Id<"legalResources">, storageId: stored.storageId as Id<"_storage">, filename: file.name, mimeType: file.type || "application/octet-stream", byteSize: file.size, sha256, sourceUrl, effectiveAt };
    const issuedAt = Date.now();
    const signature = await createWidgetServiceProof("organization-upload-finalize", issuedAt, uploadProofBytes(prepared, input));
    const versionId = await fetchAuthMutation(organizationApi.organizationContent.finalizeUpload, { ...input, issuedAt, signature });
    return Response.json({ versionId }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "BODY_TOO_LARGE";
    return Response.json({ error: tooLarge ? "The file is too large. Choose a smaller document." : "The upload could not be confirmed. Check the document's versions before trying again." }, { status: tooLarge ? 413 : 400, headers: { "cache-control": "no-store" } });
  }
}
