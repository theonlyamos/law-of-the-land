import { createHash } from "node:crypto";
import type { EvaluationEvidence } from "./evidence";
import pinned from "./data/reviewed-act651-edition.json";

export type SourceCondition = Readonly<{
  conditionId: "s55-consent" | "s55-overtime-alternatives";
  evidenceId: string; sourceQuote: string; requirement: string;
}>;
const span = pinned.spans.find(value => value.id === "p18-s55-1-2")!;
const page = pinned.pages.find(value => value.id === span.pageId)!;
const expectedText = Buffer.from(page.text, "utf8").subarray(span.startByte, span.endByte).toString("utf8");
const identityFields = ["sourceId", "versionId", "originalSha256", "originalByteLength", "pdfPageCount", "derivativeRecipeSha256"] as const;

/** Reviewed reading aids, bound to exact source bytes; they do not replace legal
 * evidence, decide user facts, or certify general/current-law coverage. A changed
 * known source cannot silently fall back to the unconditioned verifier contract. */
export function sourceConditions(evidence: EvaluationEvidence): readonly SourceCondition[] | "invalid_evidence" {
  const result: SourceCondition[] = [];
  for (const passage of evidence.passages) {
    const knownSource = passage.sourceId === pinned.identity.sourceId || passage.versionId === pinned.identity.versionId
      || passage.originalSha256 === pinned.identity.originalSha256;
    const knownSpan = passage.spanId === span.id || passage.passageSha256 === span.passageSha256 || passage.text === expectedText
      || (passage.pageId === page.id && passage.startByte === span.startByte && passage.endByte === span.endByte);
    if (!knownSource || !knownSpan) continue;
    if (result.length || passage.spanId !== span.id || identityFields.some(field => passage[field] !== pinned.identity[field])
      || passage.pageId !== page.id || passage.pdfOrdinal !== page.pdfOrdinal || passage.pageTextSha256 !== page.textSha256
      || passage.startByte !== span.startByte || passage.endByte !== span.endByte
      || passage.passageSha256 !== span.passageSha256 || passage.text !== expectedText
      || createHash("sha256").update(passage.text, "utf8").digest("hex") !== span.passageSha256) return "invalid_evidence";
    result.push(Object.freeze({ conditionId: "s55-consent", evidenceId: passage.evidenceId,
      sourceQuote: "Unless with her consent, an employer shall not",
      requirement: "The consent exception governs each action separately: paragraph (a) night work for a pregnant woman worker, and paragraph (b) overtime for a pregnant woman worker or a mother of a child less than eight months old. A qualifier attached only to one action does not qualify a separate assertion about the other action." }));
    result.push(Object.freeze({ conditionId: "s55-overtime-alternatives", evidenceId: passage.evidenceId,
      sourceQuote: "(b) engage for overtime a pregnant woman worker or a mother of a child of\nless than eight months old.",
      requirement: "For overtime only, pregnancy and motherhood of a child less than eight months old are independent alternatives. Excluding the child-age branch does not exclude an unresolved pregnancy branch. A global exclusion requires every independent alternative to be resolved against applicability. Unknown facts are not false. This motherhood alternative does not extend the night-work rule, whose subject is a pregnant woman worker." }));
  }
  return Object.freeze(result);
}

export const CONDITION_DRAFT_INSTRUCTION = "When source_conditions are supplied, use them as source-bound reading aids and check them against their quoted evidence. Preserve a shared exception for every action it governs, and preserve the scope of independent alternatives. Each paragraph or bullet must retain its governing qualifier; repeat the qualifier where needed instead of placing it only in a separate introductory segment. Distinguish excluding one alternative from excluding an entire protection; unknown facts do not establish an exclusion. Include only rules useful to answering the question, while retaining governing context. These aids are not new legal authority or established user facts.";

export const CONDITION_VERIFIER_INSTRUCTION = `Use consent for s55-consent and overtime for s55-overtime-alternatives. Split every segment into atomic claims using exact contiguous quote strings in their original order. Together these quotes must cover all non-whitespace characters of the unchanged segment, including headings and punctuation; do not paraphrase or calculate byte offsets. Separate independently qualified regulated actions and application conclusions even when they share a sentence. Keep a colon lead-in and dependent list fragments in one exact contiguous quote when they form one rule, including subject alternatives for one action; independently complete list assertions remain separate claims. Grouping never cures a missing or conflicting qualification. A single shared leading qualifier that unambiguously governs both actions may remain one logical claim with consent scope night_work_and_overtime; do not split away that governing prefix. A shared qualifier governing only overtime subject alternatives has consent scope overtime. Each claim must audit every listed condition exactly once, even if its status is non_substantive or evidence_gap. Use not_applicable only if the claim does not address that condition; it is not an exemption for an unsupported assertion.
Audit the condition against this claim's own quoted words, not a neighboring claim. A qualifier attached only to night work cannot be borrowed to qualify a separate overtime prohibition. For an applicable condition, assessment preserved means the claim correctly retains the condition in its rule or application; explicit_gap means the claim explicitly leaves the relevant fact or application unresolved without asserting an unsupported answer. overtime.conclusion records exclusion scope: none means no exclusion is asserted, including a general rule, positive application, or explicit unresolved gap; branch_only excludes one eligibility alternative without excluding the whole protection; global_exclusion excludes the whole protection. A positive application still requires support from the supplied facts and evidence; none does not waive either condition audit. For the overtime alternatives, report resolved only when every independent alternative relevant to an exclusion is resolved by the supplied user facts; otherwise unknown. Missing pregnancy facts remain unknown when a child's age changes. Use not_applicable for alternative coverage when no exclusion is asserted. The motherhood alternative belongs only to overtime, so its audit scope must be overtime even in a claim with a shared consent prefix. For non-applicable audits use scope none. A non-applicable overtime audit also uses conclusion none and alternatives not_applicable. An omitted/overstated condition or global exclusion with unknown alternatives must withhold even if other claims or a general closing disclaimer are correct.`;
