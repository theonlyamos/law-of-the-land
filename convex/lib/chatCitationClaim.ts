import type { Id } from "../_generated/dataModel";
import type { JurisdictionKind } from "./jurisdictionDomain";
import { createTelemetryServiceProof } from "./telemetryProof";

const CITATION_BINDING_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

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

export function isCitationClaimBinding(value: string): boolean {
  return CITATION_BINDING_PATTERN.test(value);
}

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function exactUtf16Digest(domain: string, values: readonly string[]): Promise<string> {
  const fields = ["chat-citation-exact-utf16-v2", domain, ...values];
  const byteLength = 4 + fields.reduce((total, field) => total + 4 + field.length * 2, 0);
  const bytes = new ArrayBuffer(byteLength);
  const view = new DataView(bytes);
  let offset = 0;
  view.setUint32(offset, fields.length, false);
  offset += 4;
  for (const field of fields) {
    view.setUint32(offset, field.length, false);
    offset += 4;
    for (let index = 0; index < field.length; index += 1) {
      view.setUint16(offset, field.charCodeAt(index), false);
      offset += 2;
    }
  }
  return base64url(await crypto.subtle.digest("SHA-256", bytes));
}

async function bindExactUtf16(domain: string, values: readonly string[]): Promise<string> {
  const digest = await exactUtf16Digest(domain, values);
  return createTelemetryServiceProof(["chat-citation-binding-hmac-v2", domain, digest]);
}

export async function createCitationClaimBindings(
  assistantClientId: string,
  assistantContent: string,
  citations: readonly ClaimCitation[],
): Promise<CitationClaimBindings> {
  const citationParts: string[] = [String(citations.length)];
  for (const citation of citations) {
    citationParts.push(
      citation.label,
      String(citation.jurisdictionId),
      citation.jurisdictionName,
      citation.jurisdictionKind,
      citation.relation,
    );
  }
  const [assistantClientIdBinding, assistantContentBinding, orderedCitationBinding] = await Promise.all([
    bindExactUtf16("assistant-client-id-v2", [assistantClientId]),
    bindExactUtf16("assistant-content-v2", [assistantContent]),
    bindExactUtf16("ordered-citation-dto-v2", citationParts),
  ]);
  return { assistantClientIdBinding, assistantContentBinding, orderedCitationBinding };
}

export async function citationClaimIssueProofParts(input: {
  externalId: string;
  jurisdictionId: Id<"jurisdictions"> | string;
} & CitationClaimBindings): Promise<readonly string[]> {
  if (!isCitationClaimBinding(input.assistantClientIdBinding) ||
    !isCitationClaimBinding(input.assistantContentBinding) ||
    !isCitationClaimBinding(input.orderedCitationBinding)) {
    throw new Error("INVALID_CHAT_CITATION_BINDING");
  }
  const selectionBinding = await exactUtf16Digest("issue-selection-v2", [
    input.externalId,
    String(input.jurisdictionId),
  ]);
  return [
    "issue-chat-citation-claim-v2",
    selectionBinding,
    input.assistantClientIdBinding,
    input.assistantContentBinding,
    input.orderedCitationBinding,
  ];
}
