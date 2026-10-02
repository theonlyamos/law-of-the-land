import { GoogleGenAI } from "@google/genai";
import { GeminiFileSearchChat } from "@/lib/gemini-file-search-chat";
import {
  assertResearchRequest, callGuestBridge, guestError, guestFailure, guestJson,
  guestSessionHash, researchBody, researchIp,
} from "@/lib/guest-research-server";
import { createOpaqueTelemetryToken, hashOpaqueTelemetryValue } from "@/convex/lib/telemetryProof";
import { validWidgetRequestId } from "@/convex/lib/widgetContracts";
import { isChatPolicyResponse } from "@/convex/lib/chatPolicy";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: Request) {
  try {
    assertResearchRequest(request);
    const tokenHash = await guestSessionHash(request);
    if (!tokenHash) return guestJson(null);
    const result = await callGuestBridge("read", { tokenHash });
    return "error" in result ? guestError(result.error) : guestJson(result);
  } catch (caught) { return guestFailure(caught); }
}

export async function PUT(request: Request) {
  try {
    assertResearchRequest(request);
    const { jurisdictionId } = await researchBody(request, ["jurisdictionId"]);
    if (!jurisdictionId || jurisdictionId.length > 128 || jurisdictionId !== jurisdictionId.trim()) throw new Error("INVALID_REQUEST");
    const existing = await guestSessionHash(request);
    if (existing) {
      const result = await callGuestBridge("read", { tokenHash: existing });
      if (!("error" in result)) return guestJson(result);
      if (!["SESSION_EXPIRED", "SESSION_INVALID", "LIBRARY_CHANGED"].includes(result.error.code)) return guestError(result.error);
    }
    const token = createOpaqueTelemetryToken(), tokenHash = await hashOpaqueTelemetryValue(token);
    const result = await callGuestBridge("session", { jurisdictionId, tokenHash, ipKey: researchIp(request) });
    return "error" in result ? guestError(result.error) : guestJson(result, 200, token);
  } catch (caught) { return guestFailure(caught); }
}

async function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("GENERATION_TIMEOUT"));
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([operation, interrupted]); }
  finally { signal.removeEventListener("abort", abort); }
}

export async function POST(request: Request) {
  try {
    assertResearchRequest(request);
    const input = await researchBody(request, ["jurisdictionId", "requestId", "query"]);
    if (!input.jurisdictionId || input.jurisdictionId.length > 128 || !validWidgetRequestId(input.requestId) || !input.query.trim() || input.query.length > 4000) throw new Error("INVALID_REQUEST");
    const tokenHash = await guestSessionHash(request);
    if (!tokenHash) throw new Error("SESSION_INVALID");
    const current = await callGuestBridge("read", { tokenHash });
    if ("error" in current) return guestError(current.error);
    if (current.jurisdictionId !== input.jurisdictionId) return guestError({ code: "REQUEST_CONFLICT", message: "This guest conversation uses a different jurisdiction. Sign in to start another research thread." });
    if (!process.env.GOOGLE_AI_API_KEY) throw new Error("WIDGET_UNAVAILABLE");
    const admitted = await callGuestBridge("begin", { tokenHash, requestId: input.requestId, query: input.query.trim(), ipKey: researchIp(request) });
    if (admitted.kind === "denied") return guestError(admitted.error);
    if (admitted.kind === "existing") {
      const result = await callGuestBridge("read", { tokenHash });
      return "error" in result ? guestError(result.error) : guestJson(result, admitted.turn.status === "pending" ? 202 : 200);
    }
    const timeout = AbortSignal.timeout(90_000);
    const providerSignal = AbortSignal.any([request.signal, timeout]);
    const terminalSignal = AbortSignal.timeout(110_000), started = Date.now();
    let providerFinished = false;
    try {
      const engine = new GeminiFileSearchChat(new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY }), process.env);
      const result = await untilAborted(engine.run({
        query: input.query.trim(), stores: admitted.manifest.stores, history: admitted.messages, maxOutputTokens: 4096,
      }, {
        signal: providerSignal, deadlineAt: started + 90_000, streamSignal: providerSignal,
        streamDeadlineAt: started + 90_000, onDelta: () => {}, onStreamComplete: () => { providerFinished = true; },
      }), providerSignal);
      providerFinished = true;
      const turn = await callGuestBridge("finish", {
        turnId: admitted.turnId, attemptNonce: admitted.attemptNonce, outcome: "completed",
        answer: result.answer, answerKind: isChatPolicyResponse(result.answer) ? "policy" : "legal",
        citations: result.citations, providerFinished,
      }, { signal: terminalSignal });
      if (turn.status !== "completed") return guestError(turn.error ?? { code: "ANSWER_UNAVAILABLE", message: "We couldn't validate this answer. Please try again." });
      const view = await callGuestBridge("read", { tokenHash }, { signal: terminalSignal });
      return "error" in view ? guestError(view.error) : guestJson(view);
    } catch {
      const error = { code: timeout.aborted ? "GENERATION_TIMEOUT" as const : "ANSWER_UNAVAILABLE" as const,
        message: "We couldn't finish this answer. Check the conversation before trying again; failed answers don't use your trial." };
      try {
        await callGuestBridge("finish", {
          turnId: admitted.turnId, attemptNonce: admitted.attemptNonce,
          outcome: request.signal.aborted ? "aborted" : "failed", citations: [], error, providerFinished,
        }, { signal: terminalSignal });
      } catch { /* The canonical turn can still be recovered by GET after its lease expires. */ }
      return guestError(error);
    }
  } catch (caught) { return guestFailure(caught); }
}
