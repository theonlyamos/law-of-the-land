// @vitest-environment node
import { GoogleGenAI } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiEvaluationVerifier } from "./gemini-verifier";
import { CONDITIONED_VERDICT_JSON_SCHEMA, segmentEvaluationCandidate, validateEvaluationVerdict } from "./verdict";
import type { EvaluationEvidence } from "./evidence";
import { selectEmploymentEvidence } from "./employment-evidence";
import { createReviewedPassageDraft } from "./reviewed-passage-draft";

const evidence: EvaluationEvidence = { purpose: "offline_evaluation", productionEligible: false, passages: [] };
afterEach(() => { vi.unstubAllGlobals(); });

describe("documented Gemini request contract", () => {
  it.each([400, 503])("serializes the simple verdict schema without network or retry after HTTP %s", async (status) => {
    const requests: { url: URL; method: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push({ url: new URL(request.url), method: request.method, body: await request.json() });
      return new Response(JSON.stringify({ error: { code: status, status: status === 400 ? "INVALID_ARGUMENT" : "UNAVAILABLE", message: "Synthetic offline rejection." } }),
        { status, headers: { "content-type": "application/json" } });
    });
    const client = new GoogleGenAI({ apiKey: "offline-placeholder-not-a-credential", vertexai: false, enterprise: false,
      httpOptions: { baseUrl: "https://generativelanguage.googleapis.com" } });
    const result = await createGeminiEvaluationVerifier(client).evaluate({ question: "Synthetic question", candidate: "The issue is unresolved.",
      evidence, deadlineAt: Date.now() + 5000 });
    expect(result).toMatchObject({ reason: "provider_error", evaluated: false, attemptCount: 1 });
    expect(requests).toHaveLength(1);
    expect(requests[0].url.origin).toBe("https://generativelanguage.googleapis.com");
    expect(requests[0].url.pathname).toBe("/v1beta/interactions");
    expect(requests[0].method).toBe("POST");
    const request = requests[0].body;
    expect(Object.keys(request).sort()).toEqual(["generation_config", "input", "model", "response_format", "store", "stream", "system_instruction", "tools"].sort());
    expect(request).toMatchObject({ model: "gemini-3.8-flash", tools: [], store: false, stream: false,
      generation_config: { thinking_level: "medium", thinking_summaries: "none", tool_choice: "none", max_output_tokens: 8192 },
      response_format: { type: "text", mime_type: "application/json" } });
    const schema = request.response_format.schema;
    // The API supports a schema subset and warns against large nested array bounds.
    // Wire constraints guide output; the independent local validator remains authoritative.
    expect(JSON.stringify(schema)).not.toMatch(/"(?:minLength|maxLength|pattern|uniqueItems|maxItems)"/);
    expect(schema).toMatchObject({ type: "object", additionalProperties: false, required: ["decision", "segments"], properties: {
      decision: { type: "string", enum: ["pass", "withhold"] }, segments: { type: "array", minItems: 1, items: {
        type: "object", additionalProperties: false, required: ["segmentId", "claims"], properties: {
          claims: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
            required: ["claimId", "status", "evidenceIds"] } },
        },
      } },
    } });
  });

  it("still rejects more than 64 returned segments after simplifying the wire schema", () => {
    const candidate = segmentEvaluationCandidate("One unresolved issue.");
    if (candidate.status !== "segmented") throw new Error("invalid synthetic fixture");
    const segments = Array.from({ length: 65 }, (_, index) => ({ segmentId: `segment-${index + 1}`,
      claims: [{ claimId: `claim-${index + 1}`, status: "evidence_gap", evidenceIds: [] }] }));
    expect(validateEvaluationVerdict(JSON.stringify({ decision: "pass", segments }), candidate.segments, evidence))
      .toMatchObject({ decision: "withhold", reason: "limit_exceeded" });
  });

  it("still enforces the 64-claim total independently of wire array bounds", () => {
    const candidate = segmentEvaluationCandidate("One unresolved issue.");
    if (candidate.status !== "segmented") throw new Error("invalid synthetic fixture");
    const claims = Array.from({ length: 65 }, (_, index) => ({ claimId: `claim-${index + 1}`, status: "evidence_gap", evidenceIds: [] }));
    const verdict = (value: unknown[]) => JSON.stringify({ decision: "pass", segments: [{ segmentId: "segment-1", claims: value }] });
    expect(validateEvaluationVerdict(verdict(claims.slice(0, 64)), candidate.segments, evidence)).toMatchObject({ decision: "pass", reason: "verified" });
    expect(validateEvaluationVerdict(verdict(claims), candidate.segments, evidence)).toMatchObject({ decision: "withhold", reason: "limit_exceeded" });
  });

  it("still rejects more than eight evidence references before accepting a verdict", () => {
    const candidate = segmentEvaluationCandidate("One unresolved issue.");
    if (candidate.status !== "segmented") throw new Error("invalid synthetic fixture");
    const verdict = JSON.stringify({ decision: "pass", segments: [{ segmentId: "segment-1", claims: [
      { claimId: "claim-1", status: "evidence_gap", evidenceIds: Array.from({ length: 9 }, (_, index) => `evidence-${index + 1}`) },
    ] }] });
    expect(validateEvaluationVerdict(verdict, candidate.segments, evidence)).toMatchObject({ decision: "withhold", reason: "limit_exceeded" });
  });
});

function conditionedFixture(kind: "age" | "refusal") {
  const question = kind === "age"
    ? "I breastfeed my nine-month-old child and have not agreed to overtime. Can my employer require it?"
    : "My employer threatens dismissal for refusing a task. Would consent matter for night work or overtime?";
  const selected = selectEmploymentEvidence({ question, history: [], attachments: [] });
  if (selected.status !== "selected") throw new Error("invalid reviewed fixture");
  const evidenceId = selected.evidence.passages.find(passage => passage.spanId === "p18-s55-1-2")!.evidenceId;
  const noConsent = () => ({ assessment: "not_applicable", scope: "none" });
  const noOvertime = () => ({ assessment: "not_applicable", scope: "none", conclusion: "none", alternatives: "not_applicable" });
  const consent = (scope: string) => ({ assessment: "preserved", scope });
  const alternatives = (conclusion = "none", coverage = "not_applicable") => ({
    assessment: "preserved", scope: "overtime", conclusion, alternatives: coverage });
  const paragraphs = kind === "age" ? [
    { text: "Under the supplied section 55(1)(b), without her consent an employer must not engage a pregnant worker or a mother of a child less than eight months old for overtime.",
      consent: consent("overtime"), overtime: alternatives(), status: "supported" },
    { text: "Your nine-month-old child does not meet that child-age alternative; whether you are pregnant remains unknown.",
      consent: noConsent(), overtime: alternatives("branch_only", "unknown"), status: "supported" },
    { text: "These excerpts do not resolve your overall position.",
      consent: noConsent(), overtime: noOvertime(), status: "evidence_gap" },
  ] : [
    { text: "Your actual task is not identified, so these excerpts do not establish whether refusing it is protected.",
      consent: noConsent(), overtime: noOvertime(), status: "evidence_gap" },
    { text: "Without her consent, section 55(1)(a) prohibits assigning a pregnant worker night work between 10 p.m. and 7 a.m.",
      consent: consent("night_work"), overtime: noOvertime(), status: "supported" },
    { text: "Without her consent, section 55(1)(b) prohibits overtime for a pregnant worker or a mother of a child less than eight months old.",
      consent: consent("overtime"), overtime: alternatives(), status: "supported" },
  ];
  const candidate = paragraphs.map(paragraph => paragraph.text).join("\n\n");
  const verdict = { decision: "pass", segments: paragraphs.map((paragraph, index) => ({ segmentId: `segment-${index + 1}`,
    claims: [{ claimId: `claim-${index + 1}`, status: paragraph.status,
      evidenceIds: paragraph.status === "supported" ? [evidenceId] : [], quote: paragraph.text,
      consent: paragraph.consent, overtime: paragraph.overtime }] })) };
  return { selected, candidate, verdict };
}

/** Real installed SDK, with every fetch handled locally; no socket or real key. */
function syntheticTransport(responses: readonly { status?: number; value: unknown }[]) {
  const requests: { url: URL; method: string; body: any }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({ url: new URL(request.url), method: request.method, body: await request.json() });
    const response = responses[requests.length - 1];
    if (!response) throw new Error("unexpected synthetic transport request");
    return new Response(JSON.stringify(response.value), { status: response.status ?? 200,
      headers: { "content-type": "application/json" } });
  });
  const client = new GoogleGenAI({ apiKey: "offline-placeholder-not-a-credential", vertexai: false, enterprise: false,
    httpOptions: { baseUrl: "https://generativelanguage.googleapis.com" } });
  return { client, requests };
}
const completedText = (text: string) => ({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text }] }] });

describe("conditioned verdict installed-SDK transport regression controls", () => {
  it.each(["age", "refusal"] as const)("round-trips a complete %s audit with draft cap 4096 and verifier cap 8192", async kind => {
    const fixture = conditionedFixture(kind);
    const transport = syntheticTransport([
      { value: completedText(JSON.stringify({ candidate: fixture.candidate })) },
      { value: completedText(JSON.stringify(fixture.verdict)) },
    ]);
    const draft = await createReviewedPassageDraft(transport.client).draft({ ...fixture.selected,
      sourceDisplayTitle: "Labour Act, 2003 (Act 651)", requestStartedAt: Date.now() });
    expect(draft).toMatchObject({ status: "drafted", candidate: fixture.candidate, attemptCount: 1 });
    const result = await createGeminiEvaluationVerifier(transport.client).evaluate({ ...fixture.selected,
      candidate: fixture.candidate, deadlineAt: Date.now() + 5000 });
    expect(result).toMatchObject({ decision: "pass", reason: "verified", evaluated: true, attemptCount: 1, claimCount: 3 });
    expect(transport.requests).toHaveLength(2);
    for (const [index, request] of transport.requests.entries()) {
      expect(request.url.pathname).toBe("/v1beta/interactions");
      expect(request.method).toBe("POST");
      expect(request.body).toMatchObject({ tools: [], store: false, stream: false,
        generation_config: { max_output_tokens: index === 0 ? 4096 : 8192,
          thinking_level: "medium", thinking_summaries: "none", tool_choice: "none" } });
    }
    const draftPayload = JSON.parse(transport.requests[0].body.input);
    const verifierPayload = JSON.parse(transport.requests[1].body.input);
    expect(draftPayload.question).toBe(verifierPayload.question);
    expect(draftPayload.user_facts).toBe(verifierPayload.facts);
    expect(draftPayload.source_conditions).toEqual(verifierPayload.source_conditions);
    expect(verifierPayload.source_conditions).toHaveLength(2);
    expect(transport.requests[1].body.response_format.schema).toEqual(CONDITIONED_VERDICT_JSON_SCHEMA);
  });

  it.each(["legacy", "truncated", "omitted_condition"] as const)("identifies the %s verdict control after an HTTP-success SDK response", async mode => {
    const fixture = conditionedFixture("age");
    let raw = JSON.stringify(fixture.verdict);
    if (mode === "legacy") raw = JSON.stringify({ decision: "pass", segments: fixture.verdict.segments.map(segment => ({
      segmentId: segment.segmentId, claims: segment.claims.map(({ claimId, status, evidenceIds }) => ({ claimId, status, evidenceIds })),
    })) });
    if (mode === "truncated") raw = raw.slice(0, -12);
    if (mode === "omitted_condition") {
      fixture.verdict.decision = "withhold";
      fixture.verdict.segments[0].claims[0].consent.assessment = "omitted_or_overstated";
      raw = JSON.stringify(fixture.verdict);
    }
    const transport = syntheticTransport([{ value: completedText(raw) }]);
    const result = await createGeminiEvaluationVerifier(transport.client).evaluate({ ...fixture.selected,
      candidate: fixture.candidate, deadlineAt: Date.now() + 5000 });
    expect(result).toMatchObject({ decision: "withhold", attemptCount: 1,
      reason: mode === "omitted_condition" ? "unsupported_claim" : "invalid_verdict", evaluated: mode === "omitted_condition" });
    expect(transport.requests).toHaveLength(1);
  });

  it.each(["incomplete", "in_progress"] as const)("withholds valid compact verdict text with provider status %s without retry", async status => {
    const fixture = conditionedFixture("age");
    const transport = syntheticTransport([{ value: { ...completedText(JSON.stringify(fixture.verdict)), status } }]);
    const result = await createGeminiEvaluationVerifier(transport.client).evaluate({ ...fixture.selected,
      candidate: fixture.candidate, deadlineAt: Date.now() + 5000 });
    expect(result).toMatchObject({ decision: "withhold", reason: "incomplete_response", evaluated: false,
      attemptCount: 1, responseStatus: status });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0].method).toBe("POST");
    expect(transport.requests[0].url.pathname).toBe("/v1beta/interactions");
    expect(transport.requests[0].body.response_format.schema).toEqual(CONDITIONED_VERDICT_JSON_SCHEMA);
  });

  it.each([400, 503])("retains one conditioned request after synthetic HTTP %s without SDK retry", async status => {
    const fixture = conditionedFixture("age");
    const transport = syntheticTransport([{ status, value: { error: { code: status, message: "Synthetic offline rejection." } } }]);
    const result = await createGeminiEvaluationVerifier(transport.client).evaluate({ ...fixture.selected,
      candidate: fixture.candidate, deadlineAt: Date.now() + 5000 });
    expect(result).toMatchObject({ decision: "withhold", reason: "provider_error", evaluated: false, attemptCount: 1 });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0].body.response_format.schema).toEqual(CONDITIONED_VERDICT_JSON_SCHEMA);
  });
});
