import { publicWidgetConfig } from "@/lib/embed/server";
export async function GET(request: Request, context: { params: Promise<{ embedId: string }> }) {
  if (process.env.WIDGET_CHAT_ENABLED !== "true") return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  const origin = request.headers.get("origin");
  if (!origin) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  try {
    const { embedId } = await context.params;
    const config = await publicWidgetConfig(embedId, origin);
    if (!config) return new Response(null, { status: 404, headers: { "cache-control": "no-store", vary: "Origin" } });
    return Response.json(config, { headers: { "access-control-allow-origin": origin, vary: "Origin", "cache-control": "no-store" } });
  } catch { return new Response(null, { status: 503, headers: { "cache-control": "no-store" } }); }
}
