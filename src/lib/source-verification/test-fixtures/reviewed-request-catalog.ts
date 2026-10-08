import { readFile } from "node:fs/promises";
import { join } from "node:path";
import catalogData from "./reviewed-request-catalog.json";
import { selectEmploymentEvidence } from "../employment-evidence";
import type { EvaluationVerifierInput } from "../verdict";
import { deepFreeze, prepareSplitInput, sha256 } from "../split-verification/contracts";
import { GOOGLE_PROVIDER_SETTINGS } from "../split-verification/google-provider-settings";

export const CATALOG_SHA256 = "2488e80193506845723e04bb5b4636cc603d7628ee7c17d82a33462fc835b1b8";
export const CASE_IDS = ["nine-month-control", "shared-qualifier", "limits", "missing-consent", "unknown-exclusion", "positive-application"] as const;
export type CaseId = typeof CASE_IDS[number];
export const CATALOG = deepFreeze(catalogData);
export const SETTINGS = deepFreeze({
  endpoint: GOOGLE_PROVIDER_SETTINGS.endpoint, model: GOOGLE_PROVIDER_SETTINGS.model,
  thinkingLevel: GOOGLE_PROVIDER_SETTINGS.thinkingLevel, maxOutputTokens: GOOGLE_PROVIDER_SETTINGS.maxOutputTokens,
  maxWireBytes: GOOGLE_PROVIDER_SETTINGS.maxWireBytes, maxRawResponseBytes: GOOGLE_PROVIDER_SETTINGS.maxRawResponseBytes,
  maxModelJsonBytes: GOOGLE_PROVIDER_SETTINGS.maxModelJsonBytes, maxConcurrentCalls: 2, maxCampaignPosts: 18,
  deadlineMs: GOOGLE_PROVIDER_SETTINGS.deadlineMs,
  retries: 0, gets: 0, redirects: 0, store: false, stream: false,
});

/** Pure local resolution retains the complete reviewed evidence, including review
 * fields absent from the historical wire projection. Never rebuild from a fixture. */
export function caseInput(caseId: CaseId): EvaluationVerifierInput {
  const item = CATALOG.cases.find(c => c.caseId === caseId);
  if (!item || !CASE_IDS.includes(caseId)) throw new Error("catalog_case_rejected");
  const selected = selectEmploymentEvidence({ question: CATALOG.sharedHistoricalWireContext.question, history: [], attachments: [] });
  if (selected.status !== "selected" || selected.facts !== CATALOG.sharedHistoricalWireContext.facts) throw new Error("catalog_source_rejected");
  const input = deepFreeze({ question: selected.question, facts: selected.facts, candidate: item.candidate, evidence: selected.evidence });
  const prepared = prepareSplitInput(input);
  if (!prepared || sha256(item.candidate) !== item.candidateSha256 || Buffer.byteLength(item.candidate) !== item.candidateUtf8Bytes) throw new Error("catalog_input_rejected");
  const { purpose, productionEligible, question, facts, source_conditions, evidence } = prepared.context;
  const projection = { purpose, productionEligible, question, facts, source_conditions, evidence };
  if (sha256(JSON.stringify(projection)) !== CATALOG.sharedContextSha256
    || JSON.stringify(projection) !== JSON.stringify(CATALOG.sharedHistoricalWireContext)) throw new Error("catalog_projection_rejected");
  return input;
}

export function validateCaseInput(caseId: CaseId, input: EvaluationVerifierInput): void {
  const expected = prepareSplitInput(caseInput(caseId)), actual = prepareSplitInput(input);
  if (!actual || !expected || actual.contextSha256 !== expected.contextSha256) throw new Error("catalog_input_drift");
}

export async function loadCatalog(bytes?: Uint8Array): Promise<typeof CATALOG> {
  const body = bytes ?? await readFile(join(__dirname, "reviewed-request-catalog.json"));
  if (sha256(Buffer.from(body).toString("utf8")) !== CATALOG_SHA256
    || JSON.stringify(CATALOG.cases.map(c => c.caseId)) !== JSON.stringify(CASE_IDS)) throw new Error("catalog_hash_drift");
  for (const caseId of CASE_IDS) caseInput(caseId);
  return CATALOG;
}
