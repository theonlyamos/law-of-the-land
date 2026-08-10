import type { Id } from "../_generated/dataModel";
import type { JurisdictionKind } from "./jurisdictionDomain";
import { createTelemetryServiceProof } from "./telemetryProof";

export type ClaimCitation = {
  label: string;
  jurisdictionId: Id<"jurisdictions"> | string;
  jurisdictionName: string;
  jurisdictionKind: JurisdictionKind;
  relation: "selected" | "geographic_ancestor" | "organizational_geography";
};

export type CitationClaimBindings = {
  assistantClientIdBinding: string;
  assistantContentBinding: string;
  orderedCitationBinding: string;
};

export async function createCitationClaimBindings(
  assistantClientId: string,
  assistantContent: string,
  citations: readonly ClaimCitation[],
): Promise<CitationClaimBindings> {
  const parts: (string | number)[] = ["chat-citation-dto-v1", citations.length];
  for (const citation of citations) {
    parts.push(
      citation.label,
      citation.jurisdictionId,
      citation.jurisdictionName,
      citation.jurisdictionKind,
      citation.relation,
    );
  }
  const [assistantClientIdBinding, assistantContentBinding, orderedCitationBinding] = await Promise.all([
    createTelemetryServiceProof(["chat-citation-client-id-v1", assistantClientId]),
    createTelemetryServiceProof(["chat-citation-content-v1", assistantContent]),
    createTelemetryServiceProof(parts),
  ]);
  return { assistantClientIdBinding, assistantContentBinding, orderedCitationBinding };
}

export function citationClaimIssueProofParts(input: {
  externalId: string;
  jurisdictionId: Id<"jurisdictions"> | string;
} & CitationClaimBindings): readonly (string | number)[] {
  return [
    "issue-chat-citation-claim-v1",
    input.externalId,
    input.jurisdictionId,
    input.assistantClientIdBinding,
    input.assistantContentBinding,
    input.orderedCitationBinding,
  ];
}
