// @vitest-environment node
import { describe, expect, it } from "vitest";
import { EVALUATION_LIMITS } from "./evidence";
import { selectEmploymentEvidence } from "./employment-evidence";
import { buildEvaluationVerifierInput, CONDITIONED_VERDICT_JSON_SCHEMA, segmentEvaluationCandidate, validateEvaluationVerdict } from "./verdict";

const selected = selectEmploymentEvidence({ question: "Can an employer require overtime?", history: [], attachments: [] });
if (selected.status !== "selected") throw new Error("Reviewed evidence fixture unavailable");
const evidence = selected.evidence;
const evidenceId = evidence.passages.find(passage => passage.spanId === "p18-s55-1-2")!.evidenceId;
const candidate = "This worker’s eligibility remains unresolved.";
type Audit = Record<string, string>;
type WireClaim = { claimId: string; status: string; evidenceIds: string[]; quote: string;
  consent?: Audit; overtime?: Audit; [key: string]: unknown };
const consent = (assessment = "not_applicable", scope = "none"): Audit => ({ assessment, scope });
const overtime = (assessment = "not_applicable", scope = "none", conclusion = "none", alternatives = "not_applicable"): Audit =>
  ({ assessment, scope, conclusion, alternatives });
function verdict(text = candidate, overrides: Partial<WireClaim> = {}) {
  const claim: WireClaim = { claimId: "claim-1", status: "evidence_gap", evidenceIds: [evidenceId], quote: text,
    consent: consent(), overtime: overtime(), ...overrides };
  return { decision: "pass", segments: [{ segmentId: "segment-1", claims: [claim] }] };
}
function check(value: unknown, text = candidate, raw = JSON.stringify(value)) {
  const segments = segmentEvaluationCandidate(text);
  if (segments.status !== "segmented") throw new Error("Invalid candidate fixture");
  return validateEvaluationVerdict(raw, segments.segments, evidence);
}

describe("compact conditioned verdict contract", () => {
  it("requires two closed named audits without repeated condition identifiers or consent constants", () => {
    const prepared = buildEvaluationVerifierInput({ question: "Synthetic question", candidate, evidence });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.verdictSchema).toBe(CONDITIONED_VERDICT_JSON_SCHEMA);
    const claim = prepared.verdictSchema.properties.segments.items.properties.claims.items;
    expect(claim.required).toEqual(["claimId", "status", "evidenceIds", "quote", "consent", "overtime"]);
    expect(Object.keys(claim.properties)).toEqual(claim.required);
    expect(claim.properties).toMatchObject({
      consent: { additionalProperties: false, required: ["assessment", "scope"] },
      overtime: { additionalProperties: false, required: ["assessment", "scope", "conclusion", "alternatives"] },
    });
    expect(check(verdict())).toMatchObject({ decision: "pass", reason: "verified", claimCount: 1 });
  });

  it("retains explicit shared consent scope and overtime-only alternative scope", () => {
    const text = "Without her consent, a pregnant worker may not be assigned night work or overtime.";
    const value = verdict(text, { status: "supported", consent: consent("preserved", "night_work_and_overtime"),
      overtime: overtime("preserved", "overtime") });
    expect(check(value, text).reason).toBe("verified");
    value.segments[0].claims[0].overtime!.scope = "night_work_and_overtime";
    value.decision = "withhold";
    expect(check(value, text).reason).toBe("unsupported_claim");
  });

  it("preserves the distinction between a narrow branch and an unknown global exclusion", () => {
    const value = verdict(candidate, { overtime: overtime("preserved", "overtime", "branch_only", "unknown") });
    expect(check(value).reason).toBe("verified");
    value.segments[0].claims[0].overtime!.conclusion = "global_exclusion";
    value.decision = "withhold";
    expect(check(value).reason).toBe("unsupported_claim");
  });

  it.each(["supported", "contradicted", "insufficient_evidence", "evidence_gap", "non_substantive"])(
    "requires both audits even for %s", status => {
      for (const slot of ["consent", "overtime"] as const) {
        const value = verdict(candidate, { status });
        delete value.segments[0].claims[0][slot];
        expect(check(value).reason).toBe("invalid_verdict");
      }
    });

  it.each(["consent", "overtime"] as const)("rejects unknown or invariant fields in %s instead of silently repairing them", slot => {
    for (const [field, supplied] of [["conditionId", "s55-consent"], ["unexpected", "extra"],
      ...(slot === "consent" ? [["conclusion", "none"], ["alternatives", "not_applicable"]] : [])]) {
      const value = verdict();
      value.segments[0].claims[0][slot]![field] = supplied;
      expect(check(value).reason).toBe("invalid_verdict");
    }
  });

  it.each(["consent", "overtime"] as const)("rejects malformed %s slots and unknown enum values", slot => {
    for (const supplied of [null, [], "not_applicable", {}, { ...verdict().segments[0].claims[0][slot], assessment: "invented" },
      { ...verdict().segments[0].claims[0][slot], scope: "inferred" }]) {
      const value = verdict();
      Object.assign(value.segments[0].claims[0], { [slot]: supplied });
      expect(check(value).reason).toBe("invalid_verdict");
    }
  });

  it("rejects the legacy audit array and mixed contracts without fallback", () => {
    const value = verdict();
    const claim = value.segments[0].claims[0];
    claim.conditionAudits = [
      { conditionId: "s55-consent", ...consent(), conclusion: "none", alternatives: "not_applicable" },
      { conditionId: "s55-overtime-alternatives", ...overtime() },
    ];
    expect(check(value).reason).toBe("invalid_verdict");
    delete claim.consent; delete claim.overtime;
    expect(check(value).reason).toBe("invalid_verdict");
  });

  it.each(["consent", "overtime", "escaped_consent", "nested_assessment"])("rejects duplicate raw JSON keys before normalization: %s", mode => {
    const value = verdict();
    let raw = JSON.stringify(value);
    if (mode === "consent") raw = raw.replace('"consent":', '"consent":{},"consent":');
    if (mode === "overtime") raw = raw.replace('"overtime":', '"overtime":{},"overtime":');
    if (mode === "escaped_consent") raw = raw.replace('"consent":', '"consent":{},"\\u0063onsent":');
    if (mode === "nested_assessment") raw = raw.replace('"assessment":', '"assessment":"omitted_or_overstated","assessment":');
    expect(check(value, candidate, raw).reason).toBe("invalid_verdict");
  });

  it("retains raw JSON byte limits, complete syntax and decoded Unicode checks", () => {
    const value = verdict(), raw = JSON.stringify(value);
    expect(check(value, candidate, raw + " ".repeat(EVALUATION_LIMITS.maxResponseJsonBytes)).reason).toBe("limit_exceeded");
    expect(check(value, candidate, raw.slice(0, -1)).reason).toBe("invalid_verdict");
    value.segments[0].claims[0].quote = "\ud800";
    expect(check(value).reason).toBe("invalid_verdict");
  });

  it.each([107, 108])("preserves the canonical response bound with 64 claims and %s escaped characters per quote", count => {
    const quote = "x" + "\u0001".repeat(count), text = quote.repeat(64);
    const value = verdict(text);
    value.segments[0].claims = Array.from({ length: 64 }, (_, index) => ({
      ...verdict(quote).segments[0].claims[0], claimId: `claim-${index + 1}`,
    }));
    const canonical = { ...value, segments: value.segments.map(segment => ({ ...segment,
      claims: segment.claims.map(({ consent, overtime, ...claim }) => ({ ...claim, conditionAudits: [
        { conditionId: "s55-consent", ...consent, conclusion: "none", alternatives: "not_applicable" },
        { conditionId: "s55-overtime-alternatives", ...overtime },
      ] })),
    })) };
    expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeLessThanOrEqual(EVALUATION_LIMITS.maxResponseJsonBytes);
    const canonicalBytes = Buffer.byteLength(JSON.stringify(canonical), "utf8");
    const prepared = buildEvaluationVerifierInput({ question: "Synthetic question", candidate: text, evidence });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    const request = { model: "gemini-3.8-flash", input: prepared.prompt, system_instruction: prepared.systemInstruction,
      tools: [], store: false, stream: false,
      generation_config: { thinking_level: "medium", thinking_summaries: "none", tool_choice: "none", max_output_tokens: EVALUATION_LIMITS.maxOutputTokens },
      response_format: { type: "text", mime_type: "application/json", schema: prepared.verdictSchema } };
    expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeLessThanOrEqual(EVALUATION_LIMITS.maxSerializedInputBytes);
    if (count === 107) {
      expect(canonicalBytes).toBeLessThanOrEqual(EVALUATION_LIMITS.maxResponseJsonBytes);
      expect(check(value, text)).toMatchObject({ reason: "verified", claimCount: 64 });
    } else {
      expect(canonicalBytes).toBeGreaterThan(EVALUATION_LIMITS.maxResponseJsonBytes);
      expect(check(value, text)).toMatchObject({ reason: "limit_exceeded", claimCount: 0 });
    }
  });

  it("retains missing support and omitted-condition rejection independently of claim status", () => {
    for (const status of ["supported", "non_substantive", "evidence_gap"]) {
      const value = verdict(candidate, { status, consent: consent("omitted_or_overstated", "overtime") });
      value.decision = "withhold";
      expect(check(value).reason).toBe("unsupported_claim");
      value.segments[0].claims[0].evidenceIds = [];
      expect(check(value).reason).toBe("missing_support");
    }
  });

  it("requires unchanged ordered quotes including Unicode and punctuation", () => {
    const value = verdict();
    expect(check(value).reason).toBe("verified");
    value.segments[0].claims[0].quote = candidate.slice(0, -1);
    expect(check(value).reason).toBe("missing_segment");
    value.segments[0].claims[0].quote = "Eligibility is unresolved.";
    expect(check(value).reason).toBe("missing_segment");
  });
});
