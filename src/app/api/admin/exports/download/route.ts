import { getToken } from "@/lib/auth-server";

const MAX_REFERENCE_BODY_BYTES = 256;

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REFERENCE_BODY_BYTES) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REFERENCE_BODY_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function POST(request: Request) {
  const bytes = await readBoundedBody(request);
  if (!bytes || bytes.byteLength === 0) return new Response(null, { status: 400 });
  let reference = "";
  try { reference = String((JSON.parse(new TextDecoder().decode(bytes)) as { reference?: unknown }).reference ?? ""); } catch { return new Response(null, { status: 400 }); }
  if (!/^exp_[A-Za-z0-9_-]{64}$/.test(reference)) return new Response(null, { status: 404 });
  const token = await getToken();
  if (!token) return new Response(null, { status: 401 });
  const site = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  if (!site) return new Response(null, { status: 503 });
  try {
    const upstream = await fetch(`${site}/admin/export-download`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ reference }), cache: "no-store" });
    if (!upstream.ok || !upstream.body) {
      const status = upstream.status === 401 ? 401 : upstream.status === 404 ? 404 : 503;
      return new Response(null, { status, headers: { "cache-control": "no-store" } });
    }
    return new Response(upstream.body, { status: 200, headers: { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream", "content-disposition": "attachment; filename=\"conversation-export.ndjson\"", "cache-control": "no-store, private", "x-content-type-options": "nosniff" } });
  } catch {
    return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
