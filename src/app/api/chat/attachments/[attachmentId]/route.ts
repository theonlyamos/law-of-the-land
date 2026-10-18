import { makeFunctionReference } from "convex/server";
import { fetchAuthMutation, getToken } from "@/lib/auth-server";
import { applicationOrigin } from "@/lib/embed/server";
import { callChatAttachmentBridge, ChatAttachmentError, parsePrivateAttachment } from "@/lib/chat-attachment-server";

export const runtime = "nodejs";
const privateHeaders = { "cache-control": "no-store, private", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const remove = makeFunctionReference<"mutation", { attachmentId: string }, { deleted: boolean }>("chatAttachments:remove");
type Context = { params: Promise<{ attachmentId: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  try {
    const { attachmentId } = await params;
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(attachmentId)) return new Response("File not found.", { status: 404, headers: privateHeaders });
    const token = await getToken();
    if (!token) return new Response("Sign in to view this file.", { status: 401, headers: privateHeaders });
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
    const file = parsePrivateAttachment(await callChatAttachmentBridge("file", { attachmentId }, token, signal), false);
    const range = request.headers.get("range");
    const upstream = await fetch(file.url, { cache: "no-store", redirect: "error", signal, headers: range && /^bytes=(?:\d+-\d*|-\d+)$/u.test(range) ? { range } : {} });
    if (upstream.status !== 416 && (!upstream.ok || !upstream.body)) return new Response("File not found.", { status: 404, headers: privateHeaders });
    const headers = new Headers(privateHeaders);
    headers.set("content-type", file.mimeType);
    headers.set("content-security-policy", "sandbox; default-src 'none'");
    const inline = new URL(request.url).searchParams.get("download") !== "1" && (file.kind === "image" || file.mimeType === "application/pdf" || file.kind === "text");
    const filename = encodeURIComponent(file.filename).replace(/['()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    headers.set("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${filename}`);
    for (const name of ["content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name); if (value) headers.set(name, value);
    }
    return new Response(upstream.status === 416 ? null : upstream.body, { status: upstream.status, headers });
  } catch (error) {
    return new Response("The attachment is unavailable or you no longer have access to it.", { status: error instanceof ChatAttachmentError ? error.status : 503, headers: privateHeaders });
  }
}

export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  try {
    if (request.headers.get("origin") !== applicationOrigin(request)) return Response.json({ error: "Remove files from your chat." }, { status: 403, headers: privateHeaders });
    if (!await getToken()) return Response.json({ error: "Sign in to remove files." }, { status: 401, headers: privateHeaders });
    const { attachmentId } = await params;
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(attachmentId)) throw new Error("INVALID_ID");
    const result = await fetchAuthMutation(remove, { attachmentId });
    return Response.json(result, { headers: privateHeaders });
  } catch {
    return Response.json({ error: "The attachment could not be removed." }, { status: 400, headers: privateHeaders });
  }
}
