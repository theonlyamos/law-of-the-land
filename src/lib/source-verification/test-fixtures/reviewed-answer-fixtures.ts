// Authored synthetic annotations ONLY. These are never imported by production code.
import type { StageRequest } from "../split-verification/contracts";
import { CASE_IDS, CATALOG } from "./reviewed-request-catalog";

export const FAKE_CREDENTIAL = "synthetic-only-secret-DO-NOT-USE-1984";
export function authoredStage(request: StageRequest) {
  const caseId = CATALOG.cases.find(c => c.candidate === request.data.context.candidate)?.caseId;
  if (!caseId || !CASE_IDS.includes(caseId as never)) throw new Error("unknown fixture");
  if (request.stage === "inventory") {
    const negative = CATALOG.cases.find(c => c.caseId === caseId)!.expectedDecision === "withhold";
    return { stage: "inventory", decision: negative ? "withhold" : "pass", segments: request.data.context.segments.map((s, i) => ({
      segmentId: s.segmentId, claims: [{ claimId: `claim-${i + 1}`, quote: s.text,
        status: negative && i === 1 ? "insufficient_evidence" : "supported",
        evidenceIds: [s.text.startsWith("Section 56") ? "evidence-2" : "evidence-1"] }],
    })) };
  }
  return { stage: request.stage, decision: "pass", partition: "accepted", claims: request.data.inventory!.segments.flatMap(s => s.claims.map(c => ({
    claimId: c.claimId, ...(request.stage === "consent"
      ? { assessment: "not_applicable", scope: "none" }
      : { assessment: c.evidenceIds.includes("evidence-1") ? "preserved" : "not_applicable",
        scope: c.evidenceIds.includes("evidence-1") ? "overtime" : "none", conclusion: "none", alternatives: "not_applicable" }),
  }))) };
}

export function providerEnvelope(json: string) {
  return { object: "interaction", model: "gemini-3.8-flash", status: "completed", created: "2026-10-05T00:00:00Z",
    steps: [{ type: "thought", signature: "synthetic-signature" }, { type: "model_output", content: [{ type: "text", text: json }] }],
    usage: { total_input_tokens: 10, total_output_tokens: 20, total_thought_tokens: 30,
      total_cached_tokens: 0, total_tool_use_tokens: 0, total_tokens: 60 } };
}

/** Reconstruct the actual stage from its real HTTP request rather than bypassing
 * the wire adapter with an executor-shaped fake. */
export function fixtureFetch(onRequest?: (request: StageRequest, body: string) => void | Promise<void>) {
  return async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = String(init!.body), wire = JSON.parse(body), data = JSON.parse(wire.input);
    const stage = /Fixed stage: (inventory|consent|overtime)\./.exec(wire.system_instruction)![1];
    const request = { stage, data } as StageRequest;
    await onRequest?.(request, body);
    return new Response(JSON.stringify(providerEnvelope(JSON.stringify(authoredStage(request)))), { status: 200 });
  };
}
