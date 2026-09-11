import { assertGuestRequest, readWidgetBody, callWidgetBridge, trustedWidgetIp, guestTokenHash, widgetErrorResponse, widgetFailureResponse } from "@/lib/embed/server";
import { createOpaqueTelemetryToken, hashOpaqueTelemetryValue } from "../../../../../../convex/lib/telemetryProof";
type Context = { params: Promise<{ embedId: string }> };
export async function POST(request: Request, context: Context) {
  try {
    assertGuestRequest(request);
    const { embedId: publicId } = await context.params;
    const bytes = await readWidgetBody(request, 2048);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("INVALID_REQUEST"); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("parentOrigin" in body) || typeof body.parentOrigin !== "string" || body.parentOrigin.length > 500) throw new Error("INVALID_REQUEST");
    const token = createOpaqueTelemetryToken(), tokenHash = await hashOpaqueTelemetryValue(token);
    const input = { publicId, tokenHash, parentOrigin: body.parentOrigin, ipKey: trustedWidgetIp(request) };
    const result = await callWidgetBridge("session", input);
    if ("error" in result && result.error) return widgetErrorResponse(result.error);
    return Response.json({ token, expiresAt: result.expiresAt }, { headers: { "cache-control": "no-store" } });
  } catch (caught) { return widgetFailureResponse(caught); }
}
export async function DELETE(request: Request, context: Context) {
  try {
    assertGuestRequest(request);
    const { embedId: publicId } = await context.params;
    await callWidgetBridge("revoke", { publicId, tokenHash: await guestTokenHash(request) });
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch (caught) { return widgetFailureResponse(caught); }
}
