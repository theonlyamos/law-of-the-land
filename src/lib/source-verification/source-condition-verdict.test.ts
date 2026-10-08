// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { selectEmploymentEvidence } from "./employment-evidence";
import { buildEvaluationVerifierInput, segmentEvaluationCandidate, validateEvaluationVerdict } from "./verdict";
import { createReviewedPassageDraft } from "./reviewed-passage-draft";
import { createGeminiEvaluationVerifier, type GeminiEvaluationClient } from "./gemini-verifier";

const selection = () => {
  const result = selectEmploymentEvidence({ question: "Can my boss require overtime?", history: [], attachments: [] });
  if (result.status !== "selected") throw new Error("reviewed fixture unavailable");
  return result;
};
const source = selection().evidence;
const s55 = source.passages.find(p => p.spanId === "p18-s55-1-2")!.evidenceId;
const obligations = ["s55-consent", "s55-overtime-alternatives"];
const candidate = "A mother with a child of nine months is no longer protected by this provision.";
function segments(text: string) {
  const result = segmentEvaluationCandidate(text);
  if (result.status !== "segmented") throw new Error("invalid fixture");
  return result.segments;
}
const consent = (scope = "overtime", assessment = "preserved") => ({ assessment, scope });
const alternatives = (conclusion = "none", coverage = "not_applicable", assessment = "preserved", scope = "overtime") =>
  ({ assessment, scope, conclusion, alternatives: coverage });
const noConsent = () => consent("none", "not_applicable");
const noOvertime = () => alternatives("none", "not_applicable", "not_applicable", "none");
function claim(quote: string, audits = { consent: noConsent(), overtime: noOvertime() }, id = "claim-1") {
  return { claimId: id, status: "supported", evidenceIds: [s55], quote, consent: audits.consent, overtime: audits.overtime };
}
function verdict(text: string, claims = [claim(text)]) {
  return { decision: "pass", segments: [{ segmentId: "segment-1", claims }] };
}
const check = (text: string, value: unknown) => validateEvaluationVerdict(JSON.stringify(value), segments(text), source);

describe("source-bound condition audit release checks", () => {
  it.each([
    candidate,
    "An employer cannot assign night work to a pregnant worker without consent, nor engage her for overtime.",
    "An infant aged ten months means this safeguard is unavailable to you.",
  ])("rejects an unaudited supported label for a complete but unqualified assertion: %s", text => {
    const oldPass = { decision: "pass", segments: [{ segmentId: "segment-1", claims: [
      { claimId: "c", status: "supported", evidenceIds: [s55] },
    ] }] };
    expect(check(text, oldPass).decision).toBe("withhold");
  });

  it.each(["omitted_or_overstated", "preserved"])("rejects a global exclusion with an unknown independent alternative (%s)", assessment => {
    expect(check(candidate, verdict(candidate, [claim(candidate, {
      consent: noConsent(), overtime: alternatives("global_exclusion", "unknown", assessment),
    })])).decision).toBe("withhold");
  });

  it("rejects omitted overtime consent despite supported claim and aggregate pass", () => {
    const text = "An employer may never engage a pregnant worker for overtime.";
    expect(check(text, verdict(text, [claim(text, { consent: consent("overtime", "omitted_or_overstated"), overtime: alternatives() })])).decision).toBe("withhold");
  });

  it.each([
    "At nine months, the child-age branch does not apply; pregnancy eligibility remains unknown.",
    "A child of twelve months falls outside the age limit; an independent pregnancy protection may still apply.",
  ])("accepts a narrow branch conclusion with the other branch unresolved: %s", text => {
    expect(check(text, verdict(text, [claim(text, { consent: noConsent(), overtime: alternatives("branch_only", "unknown") })])).decision).toBe("pass");
  });

  it.each([
    "Without her consent, a pregnant worker or a mother whose child is under eight months cannot be engaged for overtime.",
    "If she consents, this particular overtime restriction does not prohibit the assignment; other rules remain unresolved.",
  ])("accepts a correctly scoped rule or changed-consent statement: %s", text => {
    expect(check(text, verdict(text, [claim(text, { consent: consent(), overtime: alternatives() })])).decision).toBe("pass");
  });

  it("does not extend the overtime mother-only alternative to night work", () => {
    const text = "A mother of a young child may not be assigned night work without consent.";
    expect(check(text, verdict(text, [claim(text, { consent: consent("night_work"), overtime: alternatives("none", "not_applicable", "preserved", "night_work") })])).decision).toBe("withhold");
    const valid = "A pregnant worker may not be assigned night work without her consent.";
    expect(check(valid, verdict(valid, [claim(valid, { consent: consent("night_work"), overtime: noOvertime() })])).decision).toBe("pass");
  });

  it("preserves a genuine shared leading consent condition across both actions", () => {
    const text = "Without her consent, an employer must not assign a pregnant worker night work or require her to work overtime.";
    expect(check(text, verdict(text, [claim(text, { consent: consent("night_work_and_overtime"), overtime: noOvertime() })])).decision).toBe("pass");
    const local = "An employer cannot assign night work to a pregnant worker without consent, nor engage her for overtime.";
    expect(check(local, verdict(local, [claim(local, { consent: consent("night_work_and_overtime", "omitted_or_overstated"), overtime: noOvertime() })])).decision).toBe("withhold");
  });

  it.each(["missing_consent", "missing_overtime", "duplicate_legacy_audit", "unknown_audit", "non_substantive", "no_evidence"])("cannot skip condition checks through %s", mode => {
    const value = verdict(candidate);
    // Mutate the wire object directly: malformed input must not be repaired by a fixture helper.
    const entry: Record<string, unknown> = value.segments[0].claims[0];
    if (mode === "missing_consent") delete entry.consent;
    if (mode === "missing_overtime") delete entry.overtime;
    if (mode === "duplicate_legacy_audit") entry.conditionAudits = [
      { conditionId: obligations[0], ...noOvertime() }, { conditionId: obligations[0], ...noOvertime() },
    ];
    if (mode === "unknown_audit") entry.invented = noOvertime();
    if (mode === "non_substantive") { entry.status = "non_substantive"; delete entry.consent; delete entry.overtime; }
    if (mode === "no_evidence") { entry.evidenceIds = []; entry.status = "evidence_gap"; delete entry.consent; delete entry.overtime; }
    expect(check(candidate, value).decision).toBe("withhold");
  });

  it("requires exact ordered claim coverage and cannot borrow a sibling clause", () => {
    const first = "Night work needs her consent.";
    const second = " Overtime is prohibited.";
    const text = first + second;
    const value = verdict(text, [claim(first, { consent: consent("night_work"), overtime: noOvertime() }),
      claim(second, { consent: consent("overtime", "omitted_or_overstated"), overtime: alternatives() }, "claim-2")]);
    expect(check(text, value).decision).toBe("withhold");
    value.segments[0].claims[1].quote = first;
    value.segments[0].claims[1].consent = consent();
    expect(check(text, value).decision).toBe("withhold");
    expect(check(text, verdict(text, [claim(first)])).decision).toBe("withhold");
  });

  it("accepts exact Unicode quotes while deriving byte ranges locally", () => {
    const text = "A worker\u2019s eligibility remains unresolved.\n\nThe source does not establish the missing facts.";
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(text.length);
    const value = { decision: "pass", segments: segments(text).map((segment, index) => ({
      segmentId: segment.segmentId, claims: [{ ...claim(segment.text, { consent: noConsent(), overtime: noOvertime() }, `claim-${index}`), status: "evidence_gap" }],
    })) };
    expect(check(text, value).decision).toBe("pass");
  });
});

describe("source-condition projection and bound transport", () => {
  it("projects exact source-bound conditions identically for drafting and verification", async () => {
    const input = selection();
    const prepared = buildEvaluationVerifierInput({ ...input, candidate });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    const payload = JSON.parse(prepared.prompt);
    expect(payload).toHaveProperty("source_conditions");
    expect(payload.source_conditions.map((condition: { conditionId: string }) => condition.conditionId)).toEqual(obligations);
    const create = vi.fn().mockResolvedValue({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({ candidate: "The issue remains unresolved." }) }] }] });
    await createReviewedPassageDraft({ interactions: { create } } as GeminiEvaluationClient).draft({ ...input, requestStartedAt: Date.now(), sourceDisplayTitle: "Labour Act, 2003 (Act 651)" });
    expect(JSON.parse(create.mock.calls[0][0].input).source_conditions).toEqual(payload.source_conditions);
    for (const condition of payload.source_conditions) expect(source.passages.find(p => p.evidenceId === condition.evidenceId)!.text).toContain(condition.sourceQuote);
  });

  it.each([
    "Correction: my child is nine months old, not seven. I still have not agreed to overtime. Does that change the answer?",
    "Correction: I am pregnant again, and I have now agreed to overtime. Does that change the answer?",
  ])("retains chronological changed facts identically in both model requests: %s", async question => {
    const result = selectEmploymentEvidence({ question, attachments: [], history: [
      { role: "user", content: "I am a mother and my child is seven months old. I have not agreed. Can my boss require overtime?" },
      { role: "assistant", content: "You are not pregnant and can never be made to do overtime." },
    ] });
    expect(result.status).toBe("selected");
    if (result.status !== "selected") return;
    const prepared = buildEvaluationVerifierInput({ ...result, candidate: "The updated application remains unresolved." });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    const payload = JSON.parse(prepared.prompt);
    const create = vi.fn().mockResolvedValue({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({ candidate: "The updated application remains unresolved." }) }] }] });
    await createReviewedPassageDraft({ interactions: { create } } as GeminiEvaluationClient).draft({ ...result, requestStartedAt: Date.now() });
    const draftPayload = JSON.parse(create.mock.calls[0][0].input);
    expect(draftPayload.question).toBe(payload.question);
    expect(draftPayload.user_facts).toBe(payload.facts);
    expect(draftPayload.source_conditions).toEqual(payload.source_conditions);
    expect(payload.question).toBe(question);
    expect(payload.facts).toBe(result.facts);
    const history = JSON.parse(payload.facts).history;
    expect(history[0]).toMatchObject({ position: 1, role: "user", use: "unverified_user_assertion" });
    expect(history[1]).toMatchObject({ position: 2, role: "assistant", use: "conversation_only_not_facts_or_legal_authority" });
    expect(payload.source_conditions.map((condition: { conditionId: string }) => condition.conditionId)).toEqual(obligations);
  });

  it.each(["passageSha256", "text", "versionId", "spanId"])("fails closed for a changed pinned %s instead of removing condition obligations", field => {
    const evidence = structuredClone(source) as unknown as { passages: Array<Record<string, unknown>> };
    const passage = evidence.passages.find(p => p.spanId === "p18-s55-1-2")!;
    passage[field] = field === "passageSha256" ? "0".repeat(64) : field === "text" ? String(passage.text).replace("consent", "assent") : "changed-identifier";
    expect(buildEvaluationVerifierInput({ question: "Question", candidate, evidence: evidence as never })).toMatchObject({ status: "invalid", reason: "invalid_evidence" });
  });

  it("retains the ordinary contract for a legitimate non-s55 selection", () => {
    const selected = selectEmploymentEvidence({ question: "My employer wants to relocate me to another town while I am pregnant.", history: [], attachments: [] });
    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") return;
    const prepared = buildEvaluationVerifierInput({ ...selected, candidate: "The application remains unresolved." });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(JSON.parse(prepared.prompt)).not.toHaveProperty("source_conditions");
    expect(prepared.verdictSchema.properties.segments.items.properties.claims.items.required).not.toContain("conditionAudits");
    expect(prepared.verdictSchema.properties.segments.items.properties.claims.items.required).not.toContain("consent");
    expect(prepared.verdictSchema.properties.segments.items.properties.claims.items.required).not.toContain("overtime");
  });

  it("keeps a representative seven-claim audit compact within unchanged transport limits", async () => {
    const statements = [
      "The supplied edition does not establish current law or complete coverage.",
      "Without her consent, an employer may not require a pregnant worker to do the specified night work.",
      "Without her consent, the overtime rule covers a pregnant worker or a mother of a child under eight months.",
      "A child of nine months falls outside the age branch, but an independent pregnancy branch remains unresolved.",
      "Refusal of another worker's lawful-strike duties is subject to the stated danger and maintenance exception.",
      "Whether the refusal was the only reason for dismissal remains unknown from the supplied facts.",
      "An unsupported outcome should remain unresolved rather than treating an absent fact as false.",
    ];
    const text = statements.join("\n\n");
    const value = { decision: "pass", segments: segments(text).map((segment, index) => ({
      segmentId: segment.segmentId, claims: [claim(segment.text, { consent: noConsent(), overtime: noOvertime() }, `claim-${index}`)],
    })) };
    const create = vi.fn().mockResolvedValue({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(value) }] }] });
    await createGeminiEvaluationVerifier({ interactions: { create } } as GeminiEvaluationClient)
      .evaluate({ question: "What follows from these incomplete employment facts?", candidate: text, evidence: source, deadlineAt: Date.now() + 10000 });
    const request = create.mock.calls[0][0];
    const metrics = { conditionedRequestBytes: Buffer.byteLength(JSON.stringify(request), "utf8"),
      conditionedSchemaBytes: Buffer.byteLength(JSON.stringify(request.response_format.schema), "utf8"),
      sevenClaimVerdictBytes: Buffer.byteLength(JSON.stringify(value), "utf8"), maxOutputTokens: request.generation_config.max_output_tokens };
    expect(metrics.conditionedRequestBytes).toBeLessThan(128 * 1024);
    expect(metrics.sevenClaimVerdictBytes).toBeLessThan(6000);
    expect(metrics.maxOutputTokens).toBe(8192);
    console.info("condition-audit-byte-budget", JSON.stringify(metrics));
  });

  it("uses the conditioned schema with one no-tools verifier attempt and withholds a bad audit", async () => {
    const raw = verdict(candidate, [claim(candidate, { consent: noConsent(), overtime: alternatives("global_exclusion", "unknown") })]);
    const create = vi.fn().mockResolvedValue({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(raw) }] }] });
    const result = await createGeminiEvaluationVerifier({ interactions: { create } } as GeminiEvaluationClient)
      .evaluate({ question: "My child is eleven months old. Does this rule still decide my situation?", candidate, evidence: source, deadlineAt: Date.now() + 10000 });
    expect(result).toMatchObject({ decision: "withhold", attemptCount: 1 });
    expect(create).toHaveBeenCalledTimes(1);
    const [request, options] = create.mock.calls[0];
    expect(request).toMatchObject({ tools: [], stream: false, store: false, generation_config: { max_output_tokens: 8192 } });
    expect(options.maxRetries).toBe(0);
    expect(request.response_format.schema.properties.segments.items.properties.claims.items.required).toEqual(
      expect.arrayContaining(["quote", "consent", "overtime"]));
  });
});
