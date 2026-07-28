import { getToken } from "@/lib/auth-server";

export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > 256) return new Response(null, { status: 400 });
  let reference = "";
  try { reference = String((await request.json() as { reference?: unknown }).reference ?? ""); } catch { return new Response(null, { status: 400 }); }
  if (!/^exp_[A-Za-z0-9_-]{64}$/.test(reference)) return new Response(null, { status: 404 });
  const token = await getToken();
  if (!token) return new Response(null, { status: 401 });
  const site = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  if (!site) return new Response(null, { status: 503 });
  const upstream = await fetch(`${site}/admin/export-download`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ reference }), cache: "no-store" });
  if (!upstream.ok || !upstream.body) return new Response(null, { status: upstream.status === 401 ? 401 : 404, headers: { "cache-control": "no-store" } });
  return new Response(upstream.body, { status: 200, headers: { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream", "content-disposition": "attachment; filename=\"conversation-export.ndjson\"", "cache-control": "no-store, private", "x-content-type-options": "nosniff" } });
}
