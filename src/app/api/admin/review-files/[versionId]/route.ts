import { getToken } from "@/lib/auth-server";
import { createAdminFileProof } from "../../../../../../convex/lib/adminFileProof";

const privateHeaders = { "cache-control": "no-store, private", "x-content-type-options": "nosniff" };

export async function GET(request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(versionId)) return new Response("File not found.", { status: 404, headers: privateHeaders });
  const token = await getToken();
  if (!token) return new Response("Sign in to view this file.", { status: 401, headers: privateHeaders });
  const site = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  if (!site) return new Response("File viewing is unavailable.", { status: 503, headers: privateHeaders });

  try {
    const issuedAt = Date.now();
    const proof = await createAdminFileProof(versionId, issuedAt);
    const bridge = await fetch(new URL("/private/admin-review-file", site), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-file-issued-at": String(issuedAt), "x-file-proof": proof },
      body: JSON.stringify({ versionId }),
      cache: "no-store",
    });
    if (bridge.status === 401) return new Response("Access denied.", { status: 403, headers: privateHeaders });
    if (bridge.status === 404) return new Response("File not found.", { status: 404, headers: privateHeaders });
    if (!bridge.ok) return new Response("File viewing is unavailable.", { status: 503, headers: privateHeaders });
    const file: unknown = await bridge.json();
    if (!file || typeof file !== "object" || !("url" in file) || typeof file.url !== "string" || !("filename" in file) || typeof file.filename !== "string" || !("mimeType" in file) || typeof file.mimeType !== "string") throw new Error("Invalid file response");
    const range = request.headers.get("range");
    const upstream = await fetch(file.url, { headers: range && /^bytes=(?:\d+-\d*|-\d+)$/.test(range) ? { range } : {}, cache: "no-store" });
    if (upstream.status !== 416 && (!upstream.ok || !upstream.body)) return new Response("File not found.", { status: upstream.status === 404 ? 404 : 503, headers: privateHeaders });
    const headers = new Headers(privateHeaders);
    headers.set("content-type", file.mimeType);
    headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    for (const name of ["content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.status === 416 ? null : upstream.body, { status: upstream.status, headers });
  } catch {
    return new Response("File viewing is unavailable.", { status: 503, headers: privateHeaders });
  }
}
