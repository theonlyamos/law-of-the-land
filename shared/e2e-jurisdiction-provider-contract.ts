export const E2E_JURISDICTION_SCENARIOS = ["complete", "supplementary_failure", "selected_failure"] as const;
export type E2EProviderScenario = (typeof E2E_JURISDICTION_SCENARIOS)[number];
export const E2E_JURISDICTION_QUESTIONS = {
  complete: "What permits are required to operate a small business in Accra?",
  supplementary_failure: "What permits and national rules apply to a small business in Accra?",
  selected_failure: "What local permits apply to a small business in Accra?",
} as const satisfies Record<E2EProviderScenario, string>;
export const E2E_FIXTURE_TOWN_ALIAS = "Accra";

export type RetrievalObservationV2 = {
  version: 2;
  authorizedScopeSize: number;
  planSize: number;
  fileSearchCallCount: 0 | 1;
  fileSearchStoreCount: number;
  fileSearchLatencyMs: number;
  totalLatencyMs: number;
  evidenceBytes: number;
  citationCount: number;
  partialCoverage: boolean;
  jurisdictions: Array<{
    ordinal: 0 | 1 | 2 | 3;
    relation: "selected" | "geographic_ancestor" | "organizational_geography";
    coverage: "evidence" | "no_evidence" | "unavailable";
  }>;
  unexpectedRealProviderCallCount: 0;
};

export const MAX_RETRIEVAL_OBSERVATION_ENCODED_BYTES = 4_096;
export const MAX_RETRIEVAL_OBSERVATION_LATENCY_MS = 120_000;
const TOP_LEVEL_KEYS = ["authorizedScopeSize", "citationCount", "evidenceBytes", "fileSearchCallCount", "fileSearchLatencyMs", "fileSearchStoreCount", "jurisdictions", "partialCoverage", "planSize", "totalLatencyMs", "unexpectedRealProviderCallCount", "version"] as const;
const JURISDICTION_KEYS = ["coverage", "ordinal", "relation"] as const;
const RELATIONS = ["selected", "geographic_ancestor", "organizational_geography"] as const;
const COVERAGE = ["evidence", "no_evidence", "unavailable"] as const;

function invalid(): never { throw new Error("E2E_RETRIEVAL_OBSERVATION_INVALID"); }
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}
function boundedInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}
function boundedLatency(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_RETRIEVAL_OBSERVATION_LATENCY_MS;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function validateObservation(value: unknown): RetrievalObservationV2 {
  if (!isRecord(value) || !hasExactKeys(value, TOP_LEVEL_KEYS) || value.version !== 2
    || !boundedInteger(value.authorizedScopeSize, 9) || !boundedInteger(value.planSize, 4)
    || !boundedInteger(value.fileSearchCallCount, 1) || !boundedInteger(value.fileSearchStoreCount, 4)
    || !boundedLatency(value.fileSearchLatencyMs) || !boundedLatency(value.totalLatencyMs)
    || !boundedInteger(value.evidenceBytes, 240_000) || !boundedInteger(value.citationCount, 64)
    || typeof value.partialCoverage !== "boolean" || value.unexpectedRealProviderCallCount !== 0
    || !Array.isArray(value.jurisdictions) || value.jurisdictions.length > 4) invalid();
  const jurisdictions = value.jurisdictions.map((entry, index) => {
    if (!isRecord(entry) || !hasExactKeys(entry, JURISDICTION_KEYS) || entry.ordinal !== index
      || !boundedInteger(entry.ordinal, 3) || !oneOf(entry.relation, RELATIONS)
      || !oneOf(entry.coverage, COVERAGE)) invalid();
    return { ordinal: entry.ordinal as 0 | 1 | 2 | 3, relation: entry.relation, coverage: entry.coverage };
  });
  if (value.planSize !== jurisdictions.length || (value.authorizedScopeSize as number) < jurisdictions.length
    || ((value.fileSearchCallCount as number) === 0) !== ((value.fileSearchStoreCount as number) === 0)
    || ((value.fileSearchCallCount as number) === 0) !== ((value.fileSearchLatencyMs as number) === 0)
    || (value.fileSearchStoreCount as number) > jurisdictions.length
    || (value.fileSearchStoreCount as number) < jurisdictions.filter(({ coverage }) => coverage === "evidence").length
    || value.totalLatencyMs < (value.fileSearchLatencyMs as number)
    || (jurisdictions.length > 0 && jurisdictions[0].relation !== "selected")
    || jurisdictions.slice(1).some(({ relation }) => relation === "selected")
    || (jurisdictions.some(({ coverage }) => coverage === "evidence") !== ((value.evidenceBytes as number) > 0))
    || (jurisdictions[0]?.coverage === "unavailable" && jurisdictions.some(({ coverage }) => coverage === "evidence"))
    || (value.citationCount as number) > jurisdictions.filter(({ coverage }) => coverage === "evidence").length * 16
    || value.partialCoverage !== jurisdictions.slice(1).some(({ coverage }) => coverage !== "evidence")) invalid();
  return {
    version: 2, authorizedScopeSize: value.authorizedScopeSize as number, planSize: value.planSize as number,
    fileSearchCallCount: value.fileSearchCallCount as 0 | 1, fileSearchStoreCount: value.fileSearchStoreCount as number,
    fileSearchLatencyMs: value.fileSearchLatencyMs as number, totalLatencyMs: value.totalLatencyMs as number,
    evidenceBytes: value.evidenceBytes as number, citationCount: value.citationCount as number,
    partialCoverage: value.partialCoverage, jurisdictions, unexpectedRealProviderCallCount: 0,
  };
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function base64urlToBytes(encoded: string): Uint8Array {
  if (!encoded || encoded.length > MAX_RETRIEVAL_OBSERVATION_ENCODED_BYTES || !/^[A-Za-z0-9_-]+$/u.test(encoded) || encoded.length % 4 === 1) invalid();
  const padded = encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  let binary: string;
  try { binary = atob(padded); } catch { invalid(); }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToBase64url(bytes) !== encoded) invalid();
  return bytes;
}
export function decodeRetrievalObservationV2(encoded: string): RetrievalObservationV2 {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64urlToBytes(encoded))); } catch { invalid(); }
  return validateObservation(value);
}
export function encodeRetrievalObservationV2Value(value: RetrievalObservationV2): string {
  const encoded = bytesToBase64url(new TextEncoder().encode(JSON.stringify(validateObservation(value))));
  if (encoded.length > MAX_RETRIEVAL_OBSERVATION_ENCODED_BYTES) invalid();
  return encoded;
}
