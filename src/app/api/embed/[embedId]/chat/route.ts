import { GoogleGenAI } from "@google/genai";
import { GeminiFileSearchChat } from "@/lib/gemini-file-search-chat";
import { assertGuestRequest, readWidgetBody, callWidgetBridge, trustedWidgetIp, guestTokenHash, widgetErrorResponse, widgetFailureResponse } from "@/lib/embed/server";
import { parseWidgetChatBody, validWidgetRequestId } from "../../../../../../convex/lib/widgetContracts";

export const maxDuration = 120;
async function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("GENERATION_TIMEOUT"));
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([operation, interrupted]); }
  finally { signal.removeEventListener("abort", abort); }
}
type Context = { params: Promise<{ embedId: string }> };
export async function POST(request: Request, context: Context) {
  try {
    assertGuestRequest(request);
    if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) throw new Error("INVALID_REQUEST");
    const { embedId: publicId } = await context.params;
    const input = parseWidgetChatBody(await readWidgetBody(request, 32768));
    const admitted = await callWidgetBridge("begin", { publicId, tokenHash: await guestTokenHash(request), ipKey: trustedWidgetIp(request), ...input });
    if (admitted.kind === "denied") return widgetErrorResponse(admitted.error);
    if (admitted.kind === "existing") return Response.json(admitted.turn, { status: admitted.turn.status === "pending" ? 202 : 200, headers: { "cache-control": "no-store" } });
    const disconnect = new AbortController(), providerSignal = AbortSignal.any([request.signal, disconnect.signal, AbortSignal.timeout(90000)]);
    const terminalSignal = AbortSignal.timeout(110000), started = Date.now();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: unknown) => { try { controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`)); } catch { disconnect.abort(); } };
        let providerFinished = false;
        try {
          send({ type: "status", status: "generating" });
          const key = process.env.GOOGLE_AI_API_KEY;
          if (!key) throw new Error("WIDGET_UNAVAILABLE");
          const engine = new GeminiFileSearchChat(new GoogleGenAI({ apiKey: key }), process.env);
          const result = await untilAborted(engine.run({ query: input.query, stores: [admitted.authority.store], history: admitted.messages, maxOutputTokens: 4096 }, { signal: providerSignal, deadlineAt: started + 90000, streamSignal: providerSignal, streamDeadlineAt: started + 90000, onDelta: () => {}, onStreamComplete: () => { providerFinished = true; } }), providerSignal);
          providerFinished = true;
          send({ type: "status", status: "validating" });
          const done = await callWidgetBridge("finish", { turnId: admitted.turnId, attemptNonce: admitted.attemptNonce, outcome: "completed", answer: result.answer, citations: result.citations, providerFinished }, terminalSignal);
          if (done.status === "completed" && done.result) send({ type: "done", ...done.result });
          else send({ type: "error", error: done.error ?? { code: "ANSWER_UNAVAILABLE", message: "We couldn't finish this answer. Check the answer before asking again." } });
        } catch {
          const stopped = request.signal.aborted || disconnect.signal.aborted;
          const error = { code: providerSignal.aborted && !stopped ? "GENERATION_TIMEOUT" as const : "ANSWER_UNAVAILABLE" as const, message: "We couldn't finish this answer. Check the answer before asking again." };
          try { await callWidgetBridge("finish", { turnId: admitted.turnId, attemptNonce: admitted.attemptNonce, outcome: stopped ? "aborted" : "failed", citations: [], error, providerFinished }, terminalSignal); } catch { /* Recovery reads the canonical result; never release an unpersisted answer. */ }
          send({ type: "error", error });
        } finally { try { controller.close(); } catch { /* Visitor disconnected. */ } }
      },
      cancel() { disconnect.abort(); },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (caught) { return widgetFailureResponse(caught); }
}
async function turnOperation(request: Request, context: Context, operation: "read" | "cancel") {
  try {
    assertGuestRequest(request);
    const { embedId: publicId } = await context.params;
    const url = new URL(request.url), requestId = url.searchParams.get("requestId");
    if (!validWidgetRequestId(requestId) || [...url.searchParams.keys()].length !== 1) throw new Error("INVALID_REQUEST");
    const result = await callWidgetBridge(operation, { publicId, tokenHash: await guestTokenHash(request), requestId, ipKey: trustedWidgetIp(request) });
    if (!("status" in result) && result.error) return widgetErrorResponse(result.error);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (caught) { return widgetFailureResponse(caught); }
}
export async function GET(request: Request, context: Context) { return turnOperation(request, context, "read"); }
export async function DELETE(request: Request, context: Context) { return turnOperation(request, context, "cancel"); }
