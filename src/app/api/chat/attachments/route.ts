import { makeFunctionReference } from "convex/server";
import { fetchAuthMutation, getToken } from "@/lib/auth-server";
import { applicationOrigin } from "@/lib/embed/server";
import { ChatAttachmentError, readAttachmentBody } from "@/lib/chat-attachment-server";
import { validateChatAttachmentSelection } from "../../../../../shared/chat-attachments";

export const runtime = "nodejs";
const prepareUpload = makeFunctionReference<"mutation", { externalId: string; filename: string; mimeType: string; byteSize: number }, { attachmentId: string }>("chatAttachments:prepareUpload");

export async function POST(request: Request): Promise<Response> {
  const headers = { "cache-control": "no-store, private" };
  try {
    if (request.headers.get("origin") !== applicationOrigin(request)) return Response.json({ error: "Start uploads from your chat." }, { status: 403, headers });
    const token = await getToken();
    if (!token) return Response.json({ error: "Sign in to attach files." }, { status: 401, headers });
    const site = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
    if (!site) return Response.json({ error: "Attachments are unavailable right now." }, { status: 503, headers });
    const bytes = await readAttachmentBody(request, 4096, AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]));
    const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ChatAttachmentError("Choose a file to attach.");
    const value = input as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "byteSize,externalId,filename,mimeType"
      || typeof value.externalId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/u.test(value.externalId)
      || typeof value.filename !== "string" || typeof value.mimeType !== "string" || value.mimeType.length > 160 || typeof value.byteSize !== "number") throw new ChatAttachmentError("Choose a supported file to attach.");
    const error = validateChatAttachmentSelection({ name: value.filename, type: value.mimeType, size: value.byteSize });
    if (error) throw new ChatAttachmentError(error);
    const { attachmentId } = await fetchAuthMutation(prepareUpload, { externalId: value.externalId, filename: value.filename, mimeType: value.mimeType, byteSize: value.byteSize });
    return Response.json({ attachmentId, uploadUrl: new URL("/chat-attachments/upload", site).href, token }, { headers });
  } catch (error) {
    if (error instanceof Error && error.message.includes("CHAT_ATTACHMENT_RATE_LIMITED")) {
      return Response.json({ error: "Too many uploads. Wait a while before trying again." }, { status: 429, headers });
    }
    return Response.json({ error: error instanceof ChatAttachmentError ? error.message : "This upload could not be started. Check your connection and try again." }, { status: error instanceof ChatAttachmentError ? error.status : 400, headers });
  }
}
