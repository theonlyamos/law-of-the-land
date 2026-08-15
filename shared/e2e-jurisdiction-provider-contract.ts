export const E2E_JURISDICTION_SCENARIOS = [
  "complete",
  "supplementary_failure",
  "selected_failure",
] as const;

export type E2EProviderScenario = (typeof E2E_JURISDICTION_SCENARIOS)[number];

export const E2E_JURISDICTION_QUESTIONS = {
  complete: "What permits are required to operate a small business in Accra?",
  supplementary_failure: "What permits and national rules apply to a small business in Accra?",
  selected_failure: "What local permits apply to a small business in Accra?",
} as const satisfies Record<E2EProviderScenario, string>;

export const E2E_FIXTURE_TOWN_ALIAS = "Accra";

export type RetrievalObservationV1 = {
  version: 1;
  planner: { status: "planned" | "fallback"; latencyMs: number };
  authorizedScopeSize: number;
  planSize: number;
  peakConcurrency: number;
  totalLatencyMs: number;
  libraries: Array<{
    ordinal: 0 | 1 | 2 | 3;
    relation: "selected" | "geographic_ancestor" | "organizational_geography";
    status: "fulfilled" | "rejected" | "not_started" | "unconfigured";
    latencyMs: number;
  }>;
  failureCount: number;
  coverageState: "complete" | "supplementary_incomplete" | "selected_unavailable";
  providerCallCount: number;
  unexpectedRealProviderCallCount: 0;
};

export const MAX_RETRIEVAL_OBSERVATION_ENCODED_BYTES = 4_096;
export const MAX_RETRIEVAL_OBSERVATION_LATENCY_MS = 120_000;

const TOP_LEVEL_KEYS = [
  "authorizedScopeSize",
  "coverageState",
  "failureCount",
  "libraries",
  "peakConcurrency",
  "planSize",
  "planner",
  "providerCallCount",
  "totalLatencyMs",
  "unexpectedRealProviderCallCount",
  "version",
] as const;
const PLANNER_KEYS = ["latencyMs", "status"] as const;
const LIBRARY_KEYS = ["latencyMs", "ordinal", "relation", "status"] as const;
const PLANNER_STATUSES = ["planned", "fallback"] as const;
const LIBRARY_RELATIONS = ["selected", "geographic_ancestor", "organizational_geography"] as const;
const LIBRARY_STATUSES = ["fulfilled", "rejected", "not_started", "unconfigured"] as const;
const COVERAGE_STATES = ["complete", "supplementary_incomplete", "selected_unavailable"] as const;
const MAX_AUTHORIZED_SCOPE_SIZE = 9;
const MAX_LIBRARY_COUNT = 4;
const MAX_PEAK_CONCURRENCY = 3;

function invalid(): never {
  throw new Error("E2E_RETRIEVAL_OBSERVATION_INVALID");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isBoundedLatency(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_RETRIEVAL_OBSERVATION_LATENCY_MS;
}

function isBoundedInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function validateObservation(value: unknown): RetrievalObservationV1 {
  if (!isRecord(value) || !hasExactKeys(value, TOP_LEVEL_KEYS)) invalid();
  if (value.version !== 1) invalid();

  const planner = value.planner;
  if (!isRecord(planner) || !hasExactKeys(planner, PLANNER_KEYS)) invalid();
  if (!isOneOf(planner.status, PLANNER_STATUSES) || !isBoundedLatency(planner.latencyMs)) invalid();

  if (!isBoundedInteger(value.authorizedScopeSize, MAX_AUTHORIZED_SCOPE_SIZE)) invalid();
  if (!isBoundedInteger(value.planSize, MAX_LIBRARY_COUNT)) invalid();
  if (!isBoundedInteger(value.peakConcurrency, MAX_PEAK_CONCURRENCY)) invalid();
  if (!isBoundedLatency(value.totalLatencyMs)) invalid();
  const totalLatencyMs = value.totalLatencyMs;
  if (!Array.isArray(value.libraries) || value.libraries.length > MAX_LIBRARY_COUNT) invalid();

  const libraries = value.libraries.map((entry, index) => {
    if (!isRecord(entry) || !hasExactKeys(entry, LIBRARY_KEYS)) invalid();
    if (entry.ordinal !== index || !isBoundedInteger(entry.ordinal, MAX_LIBRARY_COUNT - 1)) invalid();
    if (!isOneOf(entry.relation, LIBRARY_RELATIONS)) invalid();
    if (!isOneOf(entry.status, LIBRARY_STATUSES)) invalid();
    if (!isBoundedLatency(entry.latencyMs)) invalid();
    return {
      ordinal: entry.ordinal as 0 | 1 | 2 | 3,
      relation: entry.relation,
      status: entry.status,
      latencyMs: entry.latencyMs,
    };
  });

  if (value.planSize !== libraries.length) invalid();
  if ((value.authorizedScopeSize as number) < libraries.length) invalid();
  if (!isBoundedInteger(value.failureCount, MAX_LIBRARY_COUNT)) invalid();
  if (!isOneOf(value.coverageState, COVERAGE_STATES)) invalid();
  if (!isBoundedInteger(value.providerCallCount, MAX_LIBRARY_COUNT)) invalid();
  if ((value.failureCount as number) > (value.providerCallCount as number)) invalid();
  if ((value.providerCallCount as number) > libraries.length) invalid();
  if ((value.peakConcurrency as number) > (value.providerCallCount as number)) invalid();
  if (value.unexpectedRealProviderCallCount !== 0) invalid();

  const calledLibraries = libraries.filter(({ status }) => status === "fulfilled" || status === "rejected");
  const rejectedLibraries = libraries.filter(({ status }) => status === "rejected");
  if ((value.providerCallCount as number) !== calledLibraries.length) invalid();
  if ((value.failureCount as number) !== rejectedLibraries.length) invalid();
  if (((value.providerCallCount as number) === 0) !== ((value.peakConcurrency as number) === 0)) invalid();
  if (libraries.some(({ status, latencyMs }) => (status === "not_started" || status === "unconfigured") && latencyMs !== 0)) invalid();
  if (libraries.length > 0 && libraries[0].relation !== "selected") invalid();
  if (libraries.slice(1).some(({ relation }) => relation === "selected")) invalid();
  if (totalLatencyMs < planner.latencyMs
    || libraries.some(({ latencyMs }) => totalLatencyMs < latencyMs)) invalid();

  const selectedStatus = libraries[0]?.status;
  if (value.coverageState === "complete"
    && libraries.some(({ status }) => status !== "fulfilled")) invalid();
  if (value.coverageState === "supplementary_incomplete"
    && (selectedStatus !== "fulfilled"
      || !libraries.slice(1).some(({ status }) => status !== "fulfilled"))) invalid();
  if (value.coverageState === "selected_unavailable"
    && (selectedStatus === undefined || selectedStatus === "fulfilled")) invalid();

  return {
    version: 1,
    planner: { status: planner.status, latencyMs: planner.latencyMs },
    authorizedScopeSize: value.authorizedScopeSize as number,
    planSize: value.planSize as number,
    peakConcurrency: value.peakConcurrency as number,
    totalLatencyMs,
    libraries,
    failureCount: value.failureCount as number,
    coverageState: value.coverageState,
    providerCallCount: value.providerCallCount as number,
    unexpectedRealProviderCallCount: 0,
  };
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlToBytes(encoded: string): Uint8Array {
  if (!encoded
    || encoded.length > MAX_RETRIEVAL_OBSERVATION_ENCODED_BYTES
    || !/^[A-Za-z0-9_-]+$/.test(encoded)) invalid();
  if (encoded.length % 4 === 1) invalid();
  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    invalid();
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToBase64url(bytes) !== encoded) invalid();
  return bytes;
}

export function decodeRetrievalObservationV1(encoded: string): RetrievalObservationV1 {
  if (typeof encoded !== "string") invalid();
  let value: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(base64urlToBytes(encoded));
    value = JSON.parse(json);
  } catch {
    invalid();
  }
  return validateObservation(value);
}

export function encodeRetrievalObservationV1Value(value: RetrievalObservationV1): string {
  const validated = validateObservation(value);
  const bytes = new TextEncoder().encode(JSON.stringify(validated));
  const encoded = bytesToBase64url(bytes);
  if (encoded.length > MAX_RETRIEVAL_OBSERVATION_ENCODED_BYTES) invalid();
  return encoded;
}
