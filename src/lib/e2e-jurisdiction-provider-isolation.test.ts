import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  E2E_FIXTURE_TOWN_ALIAS,
  E2E_JURISDICTION_QUESTIONS,
  E2E_JURISDICTION_SCENARIOS,
  decodeRetrievalObservationV1,
  type RetrievalObservationV1,
} from "../../shared/e2e-jurisdiction-provider-contract";
import {
  authorizedObservationSecret,
  encodeRetrievalObservationV1,
  resolveJurisdictionProviderMode,
} from "./e2e-jurisdiction-provider-isolation";

const APPROVED_SHA = "74a989459da6b197013222f0bb5c118eed994d64";
const OBSERVATION_SECRET = Buffer.alloc(32, 7).toString("base64url");

function fullBoundary(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    ADMIN_E2E_FIXTURE_MODE: "true",
    ADMIN_E2E_TARGET_ENV: "test",
    ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e",
    ADMIN_E2E_PROVIDER_STUB_MODE: "true",
    ADMIN_E2E_CONVEX_URL: "http://127.0.0.1:3210",
    ADMIN_E2E_CONVEX_SITE_URL: "http://127.0.0.1:3211",
    ADMIN_E2E_APPROVED_COMMIT_SHA: APPROVED_SHA,
    ADMIN_E2E_LOCAL_HEAD_SHA: APPROVED_SHA,
    ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: OBSERVATION_SECRET,
    ...overrides,
  };
}

function remoteBoundary(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return fullBoundary({
    ADMIN_E2E_TARGET_ENV: "preview",
    ADMIN_E2E_CONVEX_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.cloud",
    ADMIN_E2E_CONVEX_SITE_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.site",
    CONVEX_DEPLOYMENT: "dev:adventurous-hummingbird-244",
    ...overrides,
  });
}

const validObservation: RetrievalObservationV1 = {
  version: 1,
  planner: { status: "planned", latencyMs: 12.5 },
  authorizedScopeSize: 3,
  planSize: 3,
  peakConcurrency: 2,
  totalLatencyMs: 41.25,
  libraries: [
    { ordinal: 0, relation: "selected", status: "fulfilled", latencyMs: 10 },
    { ordinal: 1, relation: "geographic_ancestor", status: "rejected", latencyMs: 11 },
    { ordinal: 2, relation: "organizational_geography", status: "unconfigured", latencyMs: 0 },
  ],
  failureCount: 1,
  coverageState: "supplementary_incomplete",
  providerCallCount: 2,
  unexpectedRealProviderCallCount: 0,
};

const completeObservation: RetrievalObservationV1 = {
  ...validObservation,
  libraries: validObservation.libraries.map((library) => ({
    ...library,
    status: "fulfilled" as const,
    latencyMs: 10,
  })),
  failureCount: 0,
  coverageState: "complete",
  providerCallCount: 3,
};

const selectedUnavailableObservation: RetrievalObservationV1 = {
  ...validObservation,
  peakConcurrency: 1,
  libraries: [
    { ...validObservation.libraries[0], status: "rejected", latencyMs: 10 },
    { ...validObservation.libraries[1], status: "not_started", latencyMs: 0 },
    validObservation.libraries[2],
  ],
  failureCount: 1,
  coverageState: "selected_unavailable",
  providerCallCount: 1,
};

function encodeJsonText(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function encodeUnchecked(value: unknown): string {
  return encodeJsonText(JSON.stringify(value));
}

describe("jurisdiction provider isolation boundary", () => {
  it("keeps normal mode only when every dedicated isolation value is absent", () => {
    expect(resolveJurisdictionProviderMode({})).toEqual({ mode: "normal" });

    for (const key of Object.keys(fullBoundary())) {
      expect(
        () => resolveJurisdictionProviderMode({ [key]: fullBoundary()[key] }),
        key,
      ).toThrow("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
    }
  });

  it("accepts the complete test or preview boundary and maps only exact shared questions", () => {
    expect(E2E_JURISDICTION_SCENARIOS).toEqual([
      "complete",
      "supplementary_failure",
      "selected_failure",
    ]);
    expect(E2E_FIXTURE_TOWN_ALIAS).toBe("Accra");
    expect(E2E_JURISDICTION_QUESTIONS).toEqual({
      complete: "What permits are required to operate a small business in Accra?",
      supplementary_failure: "What permits and national rules apply to a small business in Accra?",
      selected_failure: "What local permits apply to a small business in Accra?",
    });

    for (const target of ["test", "preview"]) {
      const mode = resolveJurisdictionProviderMode(fullBoundary({ ADMIN_E2E_TARGET_ENV: target }));
      expect(mode.mode).toBe("stub");
      if (mode.mode !== "stub") throw new Error("expected stub mode");
      expect(mode.observationSecret).toBe(OBSERVATION_SECRET);
      expect(mode.scenarioForQuestion(E2E_JURISDICTION_QUESTIONS.complete)).toBe("complete");
      expect(mode.scenarioForQuestion(E2E_JURISDICTION_QUESTIONS.supplementary_failure)).toBe("supplementary_failure");
      expect(mode.scenarioForQuestion(E2E_JURISDICTION_QUESTIONS.selected_failure)).toBe("selected_failure");
      expect(() => mode.scenarioForQuestion(` ${E2E_JURISDICTION_QUESTIONS.complete}`)).toThrow(
        "E2E_JURISDICTION_PROVIDER_SCENARIO_INVALID",
      );
    }
  });

  it.each([
    ["production target", { ADMIN_E2E_TARGET_ENV: "production" }],
    ["wrong marker", { ADMIN_E2E_ISOLATED_TARGET_MARKER: "development" }],
    ["disabled fixture mode", { ADMIN_E2E_FIXTURE_MODE: "false" }],
    ["disabled stub mode", { ADMIN_E2E_PROVIDER_STUB_MODE: "false" }],
    ["production deployment", { CONVEX_DEPLOYMENT: "prod:law-of-the-land" }],
    ["production-looking backend", { ADMIN_E2E_CONVEX_URL: "https://law-production.convex.cloud", ADMIN_E2E_CONVEX_SITE_URL: "https://law-production.convex.site" }],
    ["mixed local and remote URLs", { ADMIN_E2E_CONVEX_SITE_URL: "https://safe-preview.convex.site" }],
    ["different loopback hosts", { ADMIN_E2E_CONVEX_SITE_URL: "http://127.0.0.2:3211" }],
    ["mismatched remote deployments", { ADMIN_E2E_CONVEX_URL: "https://first-preview.convex.cloud", ADMIN_E2E_CONVEX_SITE_URL: "https://other-preview.convex.site" }],
    ["mismatched regional deployment labels", { ADMIN_E2E_CONVEX_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.cloud", ADMIN_E2E_CONVEX_SITE_URL: "https://cautious-penguin-9.eu-west-1.convex.site" }],
    ["mismatched regional deployment regions", { ADMIN_E2E_CONVEX_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.cloud", ADMIN_E2E_CONVEX_SITE_URL: "https://adventurous-hummingbird-244.us-east-1.convex.site" }],
    ["extra remote hostname label", { ADMIN_E2E_CONVEX_URL: "https://adventurous-hummingbird-244.eu-west-1.extra.convex.cloud", ADMIN_E2E_CONVEX_SITE_URL: "https://adventurous-hummingbird-244.eu-west-1.extra.convex.site" }],
    ["explicit remote default ports", { ADMIN_E2E_CONVEX_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.cloud:443", ADMIN_E2E_CONVEX_SITE_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.site:443" }],
    ["remote HTTP", { ADMIN_E2E_CONVEX_URL: "http://safe-preview.convex.cloud", ADMIN_E2E_CONVEX_SITE_URL: "http://safe-preview.convex.site" }],
    ["URL credentials", { ADMIN_E2E_CONVEX_URL: "https://user:password@safe-preview.convex.cloud", ADMIN_E2E_CONVEX_SITE_URL: "https://safe-preview.convex.site" }],
    ["URL query", { ADMIN_E2E_CONVEX_URL: "https://safe-preview.convex.cloud?token=secret", ADMIN_E2E_CONVEX_SITE_URL: "https://safe-preview.convex.site" }],
    ["URL path", { ADMIN_E2E_CONVEX_URL: "https://safe-preview.convex.cloud/api", ADMIN_E2E_CONVEX_SITE_URL: "https://safe-preview.convex.site" }],
    ["unsupported protocol", { ADMIN_E2E_CONVEX_URL: "ftp://127.0.0.1:3210" }],
    ["malformed approved SHA", { ADMIN_E2E_APPROVED_COMMIT_SHA: APPROVED_SHA.toUpperCase() }],
    ["malformed local SHA", { ADMIN_E2E_LOCAL_HEAD_SHA: "a".repeat(39) }],
    ["commit mismatch", { ADMIN_E2E_LOCAL_HEAD_SHA: "a".repeat(40) }],
    ["short observation secret", { ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: Buffer.alloc(31).toString("base64url") }],
    ["malformed observation secret", { ADMIN_E2E_PROVIDER_OBSERVATION_SECRET: "!".repeat(43) }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => resolveJurisdictionProviderMode(fullBoundary(overrides))).toThrow(
      "E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID",
    );
  });

  it("accepts a remote target only with its exact development deployment binding", () => {
    expect(resolveJurisdictionProviderMode(remoteBoundary())).toMatchObject({ mode: "stub" });
  });

  it.each([
    ["missing remote deployment binding", { CONVEX_DEPLOYMENT: undefined }],
    ["malformed remote deployment binding", { CONVEX_DEPLOYMENT: "preview:safe-preview" }],
    ["mismatched remote deployment binding", { CONVEX_DEPLOYMENT: "dev:other-preview" }],
    ["whitespace-padded remote deployment binding", { CONVEX_DEPLOYMENT: " dev:safe-preview" }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => resolveJurisdictionProviderMode(remoteBoundary(overrides))).toThrow(
      "E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID",
    );
  });

  it("rejects opaque remote hostnames when the explicit development binding is absent", () => {
    expect(() => resolveJurisdictionProviderMode(remoteBoundary({
      ADMIN_E2E_CONVEX_URL: "https://opaque-731.convex.cloud",
      ADMIN_E2E_CONVEX_SITE_URL: "https://opaque-731.convex.site",
      CONVEX_DEPLOYMENT: undefined,
    }))).toThrow("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
  });

  it("authorizes only the exact parent observation secret", () => {
    const authorized = new Request("https://example.invalid", {
      headers: { "x-admin-e2e-provider-observation": OBSERVATION_SECRET },
    });
    const equalLengthWrong = new Request("https://example.invalid", {
      headers: { "x-admin-e2e-provider-observation": Buffer.alloc(32, 8).toString("base64url") },
    });
    const wrongLength = new Request("https://example.invalid", {
      headers: { "x-admin-e2e-provider-observation": "short" },
    });

    expect(authorizedObservationSecret(authorized, fullBoundary())).toBe(true);
    expect(authorizedObservationSecret(equalLengthWrong, fullBoundary())).toBe(false);
    expect(authorizedObservationSecret(wrongLength, fullBoundary())).toBe(false);
    expect(authorizedObservationSecret(new Request("https://example.invalid"), fullBoundary())).toBe(false);
    expect(authorizedObservationSecret(authorized, {})).toBe(false);
  });

  it("authorizes against an already-resolved stub mode without rereading environment", () => {
    const mode = resolveJurisdictionProviderMode(fullBoundary());
    expect(mode.mode).toBe("stub");
    const authorized = new Request("https://example.invalid", {
      headers: { "x-admin-e2e-provider-observation": OBSERVATION_SECRET },
    });
    const wrong = new Request("https://example.invalid", {
      headers: { "x-admin-e2e-provider-observation": Buffer.alloc(32, 8).toString("base64url") },
    });

    expect(authorizedObservationSecret(authorized, mode)).toBe(true);
    expect(authorizedObservationSecret(wrong, mode)).toBe(false);
  });

  it("does not mistake an environment mode property for a resolved provider mode", () => {
    const environment = fullBoundary({ mode: "normal" });
    const authorized = new Request("https://example.invalid", {
      headers: { "x-admin-e2e-provider-observation": OBSERVATION_SECRET },
    });

    expect(authorizedObservationSecret(authorized, environment)).toBe(true);
  });
});

describe("retrieval observation codec", () => {
  it("round-trips the exact safe version-one shape through base64url", () => {
    const encoded = encodeRetrievalObservationV1(validObservation);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain("=");
    expect(encoded.length).toBeLessThanOrEqual(4_096);
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(4_096);
    expect(decodeRetrievalObservationV1(encoded)).toEqual(validObservation);
  });

  it.each([
    ["complete", completeObservation],
    ["supplementary_incomplete", validObservation],
    ["selected_unavailable", selectedUnavailableObservation],
  ])("round-trips a consistent %s coverage state", (_state, observation) => {
    expect(decodeRetrievalObservationV1(encodeRetrievalObservationV1(observation))).toEqual(observation);
  });

  it.each([
    ["unknown version", { ...validObservation, version: 2 }],
    ["top-level extra key", { ...validObservation, query: "must not be serialized" }],
    ["planner extra key", { ...validObservation, planner: { ...validObservation.planner, provider: "gemini" } }],
    ["library extra key", { ...validObservation, libraries: [{ ...validObservation.libraries[0], bucketId: 11833 }, ...validObservation.libraries.slice(1) ] }],
    ["negative latency", { ...validObservation, totalLatencyMs: -1 }],
    ["nonfinite latency", { ...validObservation, totalLatencyMs: Number.POSITIVE_INFINITY }],
    ["latency above the bound", { ...validObservation, totalLatencyMs: 120_001 }],
    ["more than four libraries", { ...validObservation, planSize: 5, libraries: [...validObservation.libraries, { ordinal: 3, relation: "geographic_ancestor", status: "not_started", latencyMs: 0 }, { ordinal: 4, relation: "geographic_ancestor", status: "not_started", latencyMs: 0 }] }],
    ["invalid ordinal", { ...validObservation, libraries: [{ ...validObservation.libraries[0], ordinal: 4 }, ...validObservation.libraries.slice(1) ] }],
    ["duplicate ordinal", { ...validObservation, libraries: [validObservation.libraries[0], { ...validObservation.libraries[1], ordinal: 0 }, validObservation.libraries[2]] }],
    ["out-of-order ordinal", { ...validObservation, libraries: [validObservation.libraries[1], validObservation.libraries[0], validObservation.libraries[2]] }],
    ["concurrency above three", { ...validObservation, peakConcurrency: 4 }],
    ["unknown planner enum", { ...validObservation, planner: { status: "retried", latencyMs: 1 } }],
    ["unknown relation enum", { ...validObservation, libraries: [{ ...validObservation.libraries[0], relation: "country" }, ...validObservation.libraries.slice(1) ] }],
    ["unknown library status enum", { ...validObservation, libraries: [{ ...validObservation.libraries[0], status: "timeout" }, ...validObservation.libraries.slice(1) ] }],
    ["unknown coverage enum", { ...validObservation, coverageState: "partial" }],
    ["nonzero real-provider calls", { ...validObservation, unexpectedRealProviderCallCount: 1 }],
    ["call count inconsistent with statuses", { ...validObservation, providerCallCount: 1 }],
    ["failure count inconsistent with statuses", { ...validObservation, failureCount: 0 }],
    ["zero concurrency despite calls", { ...validObservation, peakConcurrency: 0 }],
    ["latency for an uncalled library", { ...validObservation, libraries: [validObservation.libraries[0], validObservation.libraries[1], { ...validObservation.libraries[2], latencyMs: 1 }] }],
    ["total latency below a component", { ...validObservation, totalLatencyMs: 5 }],
    ["first library is not selected", { ...validObservation, libraries: [{ ...validObservation.libraries[0], relation: "geographic_ancestor" }, ...validObservation.libraries.slice(1) ] }],
    ["complete coverage with a rejected library", { ...validObservation, coverageState: "complete" }],
    ["complete coverage with an unconfigured library", { ...validObservation, libraries: [validObservation.libraries[0], { ...validObservation.libraries[1], status: "fulfilled" }, validObservation.libraries[2]], failureCount: 0, coverageState: "complete" }],
    ["complete coverage with a not-started library", { ...validObservation, libraries: [validObservation.libraries[0], { ...validObservation.libraries[1], status: "fulfilled" }, { ...validObservation.libraries[2], status: "not_started" }], failureCount: 0, coverageState: "complete" }],
    ["supplementary-incomplete coverage without an incomplete supplementary library", { ...completeObservation, coverageState: "supplementary_incomplete" }],
    ["supplementary-incomplete coverage with an unavailable selected library", { ...selectedUnavailableObservation, coverageState: "supplementary_incomplete" }],
    ["selected-unavailable coverage with a fulfilled selected library", { ...validObservation, coverageState: "selected_unavailable" }],
  ])("rejects %s", (_label, value) => {
    expect(() => decodeRetrievalObservationV1(encodeUnchecked(value))).toThrow(
      "E2E_RETRIEVAL_OBSERVATION_INVALID",
    );
  });

  it("rejects malformed, noncanonical, and over-cap inputs before returning data", () => {
    expect(() => decodeRetrievalObservationV1("not+base64")).toThrow("E2E_RETRIEVAL_OBSERVATION_INVALID");
    expect(() => decodeRetrievalObservationV1(`${encodeUnchecked(validObservation)}=`)).toThrow(
      "E2E_RETRIEVAL_OBSERVATION_INVALID",
    );
    expect(() => decodeRetrievalObservationV1("A".repeat(6_000))).toThrow(
      "E2E_RETRIEVAL_OBSERVATION_INVALID",
    );
    expect(() => encodeRetrievalObservationV1({
      ...validObservation,
      padding: "x".repeat(5_000),
    } as never)).toThrow("E2E_RETRIEVAL_OBSERVATION_INVALID");
  });

  it("rejects a 4097-5462 character header even when decoded JSON is valid with trailing whitespace", () => {
    const json = JSON.stringify(validObservation);
    const paddedJson = `${json}${" ".repeat(3_500 - new TextEncoder().encode(json).byteLength)}`;
    const encoded = encodeJsonText(paddedJson);
    expect(encoded.length).toBeGreaterThan(4_096);
    expect(encoded.length).toBeLessThanOrEqual(5_462);
    expect(() => decodeRetrievalObservationV1(encoded)).toThrow("E2E_RETRIEVAL_OBSERVATION_INVALID");
  });
});
