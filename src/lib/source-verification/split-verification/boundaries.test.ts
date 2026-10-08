// @vitest-environment node
// These are authored annotations and synthetic boundary cases, not provider claims.
import { describe, expect, it } from "vitest";
import { selectEmploymentEvidence } from "../employment-evidence";
import { validateEvaluationVerdict } from "../verdict";
import { EVALUATION_LIMITS } from "../evidence";
import { buildStageRequest, joinSplitVerdict, prepareSplitInput, validateAudit, validateInventory } from "./contracts";

const question = "I work in Ghana and breastfeed my nine-month-old baby. My supervisor says I must work overtime even though I have not agreed. Can they make me?";
const frozenCandidate = "Under the supplied section 55(1)(b), without her consent an employer must not engage a pregnant worker or a mother of a child less than eight months old for overtime.\n\nYour nine-month-old child does not meet that child-age alternative; whether you are pregnant remains unknown.\n\nThese excerpts do not resolve your overall position.";
function fixture(candidate = frozenCandidate) {
  const selected = selectEmploymentEvidence({ question, history: [], attachments: [] });
  if (selected.status !== "selected") throw new Error("fixture missing");
  const prepared = prepareSplitInput({ ...selected, candidate })!;
  const ref = selected.evidence.passages.find(p => p.spanId === "p18-s55-1-2")!.evidenceId;
  const otherRef = selected.evidence.passages.find(p => p.evidenceId !== ref)!.evidenceId;
  return { prepared, ref, otherRef };
}
const stringify = JSON.stringify;
const consentNA = { assessment: "not_applicable", scope: "none" };
const overtimeNA = { ...consentNA, conclusion: "none", alternatives: "not_applicable" };
type AuthoredClaim = { claimId: string; status: string; quote: string; evidenceIds: string[]; consent: typeof consentNA; overtime: typeof overtimeNA };
function project(prepared: ReturnType<typeof fixture>["prepared"], claims: AuthoredClaim[][], decision = "pass") {
  const segments = prepared.segments.map((s, i) => ({ segmentId: s.segmentId, claims: claims[i] }));
  const inventory = { stage: "inventory", decision: claims.flat().some(c => ["contradicted", "insufficient_evidence"].includes(c.status)) ? "withhold" : "pass",
    segments: segments.map(s => ({ ...s, claims: s.claims.map(({ consent: _c, overtime: _o, ...claim }) => claim) })) };
  const consent = { stage: "consent", decision: claims.flat().some(c => c.consent.assessment === "omitted_or_overstated") ? "withhold" : "pass", partition: "accepted",
    claims: claims.flat().map(c => ({ claimId: c.claimId, ...c.consent })) };
  const overtime = { stage: "overtime", decision: claims.flat().some(c => c.overtime.assessment === "omitted_or_overstated" || (c.overtime.assessment !== "not_applicable"
    && (c.overtime.scope !== "overtime" || (c.overtime.conclusion === "global_exclusion" && c.overtime.alternatives !== "resolved")))) ? "withhold" : "pass", partition: "accepted",
    claims: claims.flat().map(c => ({ claimId: c.claimId, ...c.overtime })) };
  const checkedInventory = validateInventory(stringify(inventory), prepared);
  const checkedConsent = checkedInventory && validateAudit("consent", stringify(consent), prepared, checkedInventory);
  const checkedOvertime = checkedInventory && validateAudit("overtime", stringify(overtime), prepared, checkedInventory);
  const joined = checkedInventory && checkedConsent && checkedOvertime ? joinSplitVerdict(prepared, checkedInventory, checkedConsent, checkedOvertime) : undefined;
  return { inventory, consent, overtime, joined, checkedInventory, canonical: { decision, segments } };
}

describe("frozen source and exact boundary controls", () => {
  it("preserves 64 segment and eight reference limits without truncating context", () => {
    const f = fixture(Array.from({ length: 64 }, () => "Exact segment.").join("\n\n"));
    expect(f.prepared.segments).toHaveLength(64);
    expect(prepareSplitInput({ ...f.prepared.input, candidate: f.prepared.input.candidate + "\n\nOne too many." })).toBeUndefined();
    const small = fixture("A source-bound rule.");
    const passages = small.prepared.input.evidence.passages;
    const context = passages.find(p => p.evidenceId !== small.ref)!;
    const expanded = [...passages, ...Array.from({ length: 7 }, (_, i) => ({ ...context, evidenceId: `evidence-${passages.length + i + 1}` }))];
    const prepared = prepareSplitInput({ ...small.prepared.input, evidence: { ...small.prepared.input.evidence, passages: expanded } })!;
    expect(prepared).toBeDefined();
    const claims = [[{ claimId: "c", quote: prepared.input.candidate, status: "supported", evidenceIds: expanded.slice(0, 8).map(p => p.evidenceId), consent: consentNA, overtime: overtimeNA }]];
    expect(project(prepared, claims).joined?.decision).toBe("pass");
    claims[0][0].evidenceIds = expanded.slice(0, 9).map(p => p.evidenceId);
    expect(project(prepared, claims).checkedInventory).toBeUndefined();
    expect(prepareSplitInput({ ...small.prepared.input, question: "x".repeat(EVALUATION_LIMITS.maxQuestionFactsDraftBytes + 1) })).toBeUndefined();
  });

  it("the exact 331-byte three-segment four-claim control includes the authored pregnancy-gap reference", () => {
    const f = fixture();
    expect(Buffer.byteLength(frozenCandidate)).toBe(331);
    expect(f.prepared.context.question).toBe(question);
    expect(JSON.parse(f.prepared.context.facts)).toMatchObject({ kind: "untrusted_employment_context", history: [], attachments: [] });
    const clauses = [f.prepared.segments[0].text, "Your nine-month-old child does not meet that child-age alternative;", " whether you are pregnant remains unknown.", f.prepared.segments[2].text];
    const claims: AuthoredClaim[] = clauses.map((quote, i) => ({ claimId: `claim-${i + 1}`, quote, status: i > 1 ? "evidence_gap" : "supported",
      evidenceIds: i === 3 ? [] : [f.ref], consent: i === 0 ? { assessment: "preserved", scope: "overtime" } : consentNA,
      overtime: i === 3 ? overtimeNA : { assessment: i === 2 ? "explicit_gap" : "preserved", scope: "overtime", conclusion: i === 1 ? "branch_only" : "none", alternatives: i === 1 ? "unknown" : "not_applicable" } }));
    const grouped = [[claims[0]], [claims[1], claims[2]], [claims[3]]];
    expect(project(f.prepared, grouped).joined).toMatchObject({ decision: "pass", claimCount: 4, segmentCount: 3 });
    for (const status of ["evidence_gap", "non_substantive"]) for (const refs of [[], [f.otherRef]]) {
      claims[2].status = status; claims[2].evidenceIds = refs;
      // Governing ref remains on siblings and cannot be borrowed or supplied by auditors.
      expect(project(f.prepared, grouped).joined).toBeUndefined();
    }
  });

  it("projects the complete overtime enum matrix through the unchanged validator", () => {
    const f = fixture("Pregnancy and the child-age branch require an appropriately scoped conclusion.");
    for (const assessment of ["preserved", "explicit_gap", "not_applicable", "omitted_or_overstated"])
      for (const scope of ["none", "night_work", "overtime", "night_work_and_overtime"])
        for (const conclusion of ["none", "branch_only", "global_exclusion"])
          for (const alternatives of ["not_applicable", "resolved", "unknown"]) {
            const fails = assessment === "omitted_or_overstated" || (assessment !== "not_applicable" && (scope !== "overtime" || (conclusion === "global_exclusion" && alternatives !== "resolved")));
            const value = project(f.prepared, [[{ claimId: "c", quote: f.prepared.input.candidate, status: "supported", evidenceIds: [f.ref], consent: consentNA,
              overtime: { assessment, scope, conclusion, alternatives } }]], fails ? "withhold" : "pass");
            const expected = validateEvaluationVerdict(stringify(value.canonical), f.prepared.segments, f.prepared.input.evidence);
            expect(value.joined?.decision ?? "withhold").toBe(expected.decision);
          }
  });

  it("accepts 64 claims, rejects 65 and preserves final escaped canonical expansion bounds", () => {
    for (const repeats of [100, 120]) {
      const quote = "x" + "\u0001".repeat(repeats), f = fixture(quote.repeat(64));
      const claims = Array.from({ length: 64 }, (_, i) => ({ claimId: `claim-${i + 1}`, quote, status: "supported", evidenceIds: [f.ref], consent: consentNA, overtime: overtimeNA }));
      const value = project(f.prepared, [claims]);
      expect(value.checkedInventory?.segments[0].claims).toHaveLength(64);
      const expected = validateEvaluationVerdict(stringify(value.canonical), f.prepared.segments, f.prepared.input.evidence);
      expect(value.joined).toEqual(expected);
      expect(expected.decision).toBe(repeats === 100 ? "pass" : "withhold");
      const overflow = { ...value.inventory, segments: [{ ...value.inventory.segments[0], claims: [...value.inventory.segments[0].claims, value.inventory.segments[0].claims[0]] }] };
      expect(validateInventory(stringify(overflow), f.prepared)).toBeUndefined();
      if (repeats === 120) expect(buildStageRequest(f.prepared, "overtime", "server", 85000, value.checkedInventory!)).toBeUndefined();
      if (repeats === 120) {
        const consent = validateAudit("consent", stringify({ ...value.consent, decision: "withhold", partition: "rejected" }), f.prepared, value.checkedInventory!)!;
        const overtime = validateAudit("overtime", stringify(value.overtime), f.prepared, value.checkedInventory!)!;
        expect(joinSplitVerdict(f.prepared, value.checkedInventory!, consent, overtime)?.reason).toBe("limit_exceeded");
      }
    }
  });

  it("enforces raw 64KiB response bytes and rejects nested aliases in both auditors", () => {
    const f = fixture("An explicit gap remains."), value = project(f.prepared, [[{ claimId: "c", quote: f.prepared.input.candidate, status: "evidence_gap", evidenceIds: [f.ref], consent: consentNA, overtime: overtimeNA }]]);
    const serialized = stringify(value.inventory), atLimit = serialized + " ".repeat(EVALUATION_LIMITS.maxResponseJsonBytes - Buffer.byteLength(serialized));
    expect(validateInventory(atLimit, f.prepared)).toBeDefined();
    expect(validateInventory(atLimit + " ", f.prepared)).toBeUndefined();
    for (const stage of ["consent", "overtime"] as const) {
      const output = stringify(value[stage]).replace('"scope":"none"', '"scope":"none","sc\\u006fpe":"none"');
      expect(validateAudit(stage, output, f.prepared, value.checkedInventory!)).toBeUndefined();
      const missing = { ...value[stage], claims: [] };
      expect(validateAudit(stage, stringify(missing), f.prepared, value.checkedInventory!)).toBeUndefined();
      const duplicate = { ...value[stage], claims: [value[stage].claims[0], value[stage].claims[0]] };
      expect(validateAudit(stage, stringify(duplicate), f.prepared, value.checkedInventory!)).toBeUndefined();
    }
  });

  it("keeps decomposed Unicode exact and rejects skipped/reordered/overlapping quote bytes", () => {
    const text = "Cafe\u0301. Worker’s eligibility remains unknown.";
    const f = fixture(text), claim = { claimId: "c", quote: text, status: "evidence_gap", evidenceIds: [f.ref], consent: consentNA, overtime: overtimeNA };
    expect(project(f.prepared, [[claim]]).joined?.decision).toBe("pass");
    expect(project(f.prepared, [[{ ...claim, quote: text.normalize("NFC") }]]).joined).toBeUndefined();
    expect(project(f.prepared, [[{ ...claim, quote: text.slice(7) }, { ...claim, claimId: "c2", quote: text.slice(0, 7) }]]).joined).toBeUndefined();
  });
});
