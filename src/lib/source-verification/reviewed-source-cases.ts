import reviewedBundle from "./data/reviewed-act651-edition.json";
import { EVALUATION_LIMITS, resolveEvaluationEvidence, type EvaluationEvidenceRequest,
  type EvaluationRegistry, type SourceIdentity } from "./evidence";

export type PilotCase = Readonly<{
  caseId: string; question: string; topic: string; facts: string;
  requests: readonly EvaluationEvidenceRequest[]; expectedSpanIds: readonly string[];
  questionFactsUtf8Bytes: number; evidencePassageUtf8Bytes: number;
}>;
export type PublicPilotCase = Readonly<Pick<PilotCase, "caseId" | "question" | "topic">>;

/** Historical catalog identifiers are selectors for a fresh server authority check.
 * They are never substituted into the reviewed source identity or treated as grants. */
export const PILOT_CATALOG = Object.freeze({
  jurisdictionId: "md744z756x2etfcscnx9ayys8n8dp2mc",
  resourceId: "mh72janpeqm7zpa406pm1hxwvx8dpvr2",
  versionId: "kh70hvbgwbfnrsjhsxhcc9m56x8dp9rw",
});
export const PILOT_IDENTITY: Readonly<SourceIdentity> = Object.freeze({
  sourceId: "local-act651-experimental",
  versionId: "sha256-125e8ce4d70beb6fbe6adc5f9cbaec27dc435c484a62b3eee38bf80cff466f5a",
  originalSha256: "125e8ce4d70beb6fbe6adc5f9cbaec27dc435c484a62b3eee38bf80cff466f5a",
  originalByteLength: 1913139,
  pdfPageCount: 60,
  derivativeRecipeSha256: "98de129debcbe9b998a19ceced22bab0d9dd1a58bf86b885c8797a2b951debd0",
});
export const PILOT_SCOPE = "Local experimental pilot using selected reviewed passages from the supplied edition of Ghana Labour Act, 2003 (ACT 651), PDF pages 11, 12, 18 and 21. Agent review does not certify current law or the whole document. Registry inclusion does not establish current DEV authorization.";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function reviewedRegistry(): EvaluationRegistry {
  const entry = deepFreeze({ expectedIdentity: PILOT_IDENTITY, bundle: structuredClone(reviewedBundle) });
  const backing = new Map([[PILOT_IDENTITY.sourceId, entry]]);
  // Object.freeze(Map) still allows set/delete/clear. This facade never returns
  // the backing Map, including through the third argument of forEach.
  const registry: EvaluationRegistry = Object.freeze({
    size: backing.size,
    get: backing.get.bind(backing),
    has: backing.has.bind(backing),
    keys: backing.keys.bind(backing),
    values: backing.values.bind(backing),
    entries: backing.entries.bind(backing),
    [Symbol.iterator]: backing[Symbol.iterator].bind(backing),
    forEach(callback: Parameters<EvaluationRegistry["forEach"]>[0], thisArg?: unknown) {
      backing.forEach((value, key) => callback.call(thisArg, value, key, registry));
    },
  });
  return registry;
}
export const PILOT_REGISTRY = reviewedRegistry();

function defineCase(caseId: string, topic: string, question: string, facts: string,
  pdfOrdinal: number, reviewedSpanId: string, expectedSpanIds: string[],
  questionFactsUtf8Bytes: number, evidencePassageUtf8Bytes: number): PilotCase {
  const requests = [{ sourceId: PILOT_IDENTITY.sourceId, versionId: PILOT_IDENTITY.versionId, pdfOrdinal, reviewedSpanId }];
  const result = resolveEvaluationEvidence(PILOT_REGISTRY, requests);
  if (result.status !== "resolved"
    || JSON.stringify(result.evidence.passages.map(({ spanId }) => spanId).sort()) !== JSON.stringify(expectedSpanIds)
    || result.evidence.passages.reduce((sum, { text }) => sum + Buffer.byteLength(text, "utf8"), 0) !== evidencePassageUtf8Bytes
    || Buffer.byteLength(question, "utf8") + Buffer.byteLength(facts, "utf8") !== questionFactsUtf8Bytes
    || questionFactsUtf8Bytes > EVALUATION_LIMITS.maxQuestionFactsDraftBytes
    || evidencePassageUtf8Bytes > EVALUATION_LIMITS.maxEvidenceTextBytes) {
    throw new Error("Reviewed local pilot case integrity mismatch");
  }
  return deepFreeze({ caseId, topic, question, facts, requests, expectedSpanIds,
    questionFactsUtf8Bytes, evidencePassageUtf8Bytes });
}

// Synthetic questions/facts approved for this bounded pilot. No reference answer,
// expected semantic verdict, real user question, or private attachment is stored.
const cases: readonly PilotCase[] = Object.freeze([
  defineCase("pilot-notice", "Notice of termination",
    "I signed up to work for four years but have only been there six months. If my employer ends the contract now, how much notice should I get, and can they just tell me out loud?",
    "This is a synthetic Ghana employment scenario. The contract expressly runs for four years and is stipulated not to be week-to-week or determinable at will. No collective agreement contains express termination terms more beneficial to the worker. Consider only the notice period and its form, not whether the employer otherwise has a lawful reason to terminate.",
    11, "p11-s17", ["p11-s16", "p11-s17", "p12-s18-4", "p12-s19"], 535, 1641),
  defineCase("pilot-overtime", "Overtime after childbirth",
    "My baby is seven months old. Can my boss make me work overtime when I have said no?",
    "This is a synthetic Ghana employment scenario. The worker is the mother of a seven-month-old child. The proposed hours are overtime. She has not consented. No dismissal, compensation, or medical question is raised.",
    18, "p18-s55-1-2", ["p18-s55-1-2", "p18-s56-1"], 297, 879),
  defineCase("pilot-relocation", "Temporary assignment during pregnancy",
    "I'm five months pregnant. My employer wants to send me to work away from where I live for two weeks, and my midwife says the move would harm my health. Can they insist?",
    "This is a synthetic Ghana employment scenario. The worker has completed her fourth month of pregnancy. The proposed temporary post is outside her place of residence. A midwife has expressed the opinion that the assignment is detrimental to her health. Consider the assignment restriction only.",
    18, "p18-s56-1", ["p18-s56-1"], 461, 340),
  defineCase("pilot-refusal-gap", "Refusal of work and missing facts",
    "I refused a task at work and my manager is threatening to fire me. Does refusing it protect me from being fired?",
    "This is a synthetic Ghana employment scenario. The task, who normally performs it, any connection to a lawful strike, any danger to life, personal safety or health, any need to maintain plant or equipment, and the employer's reason for dismissal are not supplied. Do not invent those facts.",
    21, "p21-s63-1-2", ["p18-s55-1-2", "p18-s56-1", "p21-s63-1-2"], 402, 2498),
]);

/** Safe list projection; server callers obtain facts and locators separately. */
export const PILOT_CASES: readonly PublicPilotCase[] = Object.freeze(cases.map(({ caseId, question, topic }) =>
  Object.freeze({ caseId, question, topic })));

/** Exact allowlist lookup. Caller text can never replace a question or its facts. */
export function getPilotCase(id: string): PilotCase | undefined {
  return typeof id === "string" ? cases.find((item) => item.caseId === id) : undefined;
}
