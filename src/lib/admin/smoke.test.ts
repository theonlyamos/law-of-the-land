import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkBudgets,
  requireAdminFixtureBoundary,
} from "../../../scripts/check-admin-budgets.mjs";
import { buildJurisdictionPerformanceSections } from "../../../scripts/admin-performance-collector.mjs";

function approvedSections() {
  const samples = Array(20).fill(10);
  const observation = {
    version: 2 as const,
    authorizedScopeSize: 3,
    planSize: 3,
    fileSearchCallCount: 1 as const,
    fileSearchStoreCount: 3,
    fileSearchLatencyMs: 10,
    totalLatencyMs: 30,
    evidenceBytes: 100,
    citationCount: 2,
    partialCoverage: false,
    jurisdictions: [
      { ordinal: 0 as const, relation: "selected" as const, coverage: "evidence" as const },
      { ordinal: 1 as const, relation: "organizational_geography" as const, coverage: "evidence" as const },
      { ordinal: 2 as const, relation: "geographic_ancestor" as const, coverage: "evidence" as const },
    ],
    unexpectedRealProviderCallCount: 0 as const,
  };
  const sections = buildJurisdictionPerformanceSections({
    selectorProfiles: [
      { flagState: "off", profile: "desktop", resultRowCount: 1, samplesMs: samples, baselineP95Ms: 10 },
      { flagState: "on", profile: "desktop", resultRowCount: 2, samplesMs: samples, baselineP95Ms: 10 },
      { flagState: "on", profile: "mobile", resultRowCount: 2, samplesMs: samples, baselineP95Ms: 10 },
      { flagState: "on", profile: "throttled", resultRowCount: 2, samplesMs: samples, baselineP95Ms: 10 },
    ],
    placePicker: {
      branch: "geographic",
      autocompleteSamplesMs: samples,
      detailsSamplesMs: samples,
      resultCount: 1,
      requestCount: 40,
      sameSessionCorrelation: true,
      placesInvocationCount: 40,
    },
    organizationalPlacesInvocationCount: 0,
    retrievalObservations: Array(20).fill(observation),
  });
  Object.assign(sections.jurisdictionSelector.calibration, { status: "approved", reference: "change-record-123", outcome: "pass" });
  for (const profile of sections.jurisdictionSelector.profiles) Object.assign(profile, { approvedP95LimitMs: 20, outcome: "pass" });
  Object.assign(sections.geographicPlacePicker.calibration, {
    status: "approved", reference: "change-record-123", autocompleteP95LimitMs: 20,
    detailsP95LimitMs: 20, autocompleteOutcome: "pass", detailsOutcome: "pass", outcome: "pass",
  });
  Object.assign(sections.retrievalPlan.calibration, {
    status: "approved", reference: "change-record-123", fileSearchP95LimitMs: 20,
    totalP95LimitMs: 40, fileSearchOutcome: "pass", totalOutcome: "pass", outcome: "pass",
  });
  return sections;
}

function approvedArtifact() {
  const before = {
    lcp: 2300,
    inp: 170,
    cls: 0.04,
    routeJsGzip: 0,
    p95: 430,
  };
  const after = {
    lcp: 2400,
    inp: 180,
    cls: 0.05,
    routeJsGzip: 240_000,
    p95: 450,
  };
  const delta = {
    lcp: 100,
    inp: 10,
    cls: 0.01,
    routeJsGzip: 240_000,
    p95: 20,
  };
  return {
    artifactVersion: 2,
    commitSha: "a".repeat(40),
    timestamp: "2026-08-15T00:00:00.000Z",
    targetClass: "preview",
    browserProfile: "chromium",
    deviceProfiles: ["desktop-1280x900", "mobile-390x844"],
    networkProfiles: ["unthrottled", "150ms-1600kbps-down-750kbps-up"],
    calibratedOutcome: "pass",
    ...after,
    baseline: "authenticated-admin-overview",
    sampleCount: 20,
    before,
    after,
    delta,
    ...approvedSections(),
  };
}

describe("admin performance budgets", () => {
  it("accepts the approved limits", () => {
    expect(checkBudgets(approvedArtifact())).toEqual([]);
  });

  it("accepts the governed context's maximum UTF-8 evidence size", () => {
    const artifact = approvedArtifact();
    for (const sample of artifact.retrievalPlan.samples) sample.evidenceBytes = 360_000;
    artifact.retrievalPlan.evidenceBytes = 7_200_000;

    expect(checkBudgets(artifact)).toEqual([]);
  });

  it("rejects an unauthenticated baseline and the wrong sample count", () => {
    const artifact = {
      ...approvedArtifact(),
      baseline: "public-search-api-unauthenticated-401",
      sampleCount: 19,
    };

    expect(checkBudgets(artifact)).toEqual(
      expect.arrayContaining([
        "baseline must be authenticated-admin-overview",
        "sampleCount must be exactly 20",
      ]),
    );
  });

  it("rejects non-finite before, after, and delta structures", () => {
    const artifact = approvedArtifact();
    artifact.before.lcp = Number.NaN;
    artifact.after.inp = Number.POSITIVE_INFINITY;
    artifact.delta.cls = Number.NaN;

    expect(checkBudgets(artifact)).toEqual(
      expect.arrayContaining([
        "before must contain finite lcp, inp, cls, routeJsGzip, and p95 metrics",
        "after must contain finite lcp, inp, cls, routeJsGzip, and p95 metrics",
        "delta must contain finite lcp, inp, cls, routeJsGzip, and p95 metrics",
      ]),
    );
  });

  it("requires the complete guarded fixture boundary before budget execution", () => {
    expect(() => requireAdminFixtureBoundary({})).toThrow(
      "ADMIN_E2E_FIXTURE_MODE=true",
    );
  });

  it("preserves the exact hosted development deployment binding", () => {
    const environment = {
      ADMIN_E2E_FIXTURE_MODE: "true",
      ADMIN_E2E_TARGET_ENV: "preview",
      ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e",
      ADMIN_E2E_PROVIDER_STUB_MODE: "true",
      BILLING_ENABLED: "false",
      ADMIN_E2E_CONVEX_URL: "https://safe-preview.convex.cloud",
      ADMIN_E2E_CONVEX_SITE_URL: "https://safe-preview.convex.site",
      ADMIN_E2E_FIXTURE_SECRET: "f".repeat(32),
      ADMIN_E2E_BETTER_AUTH_SECRET: "b".repeat(32),
      ADMIN_E2E_ACCOUNT_PASSWORD: "password-1234",
      ADMIN_E2E_SEARCH_JURISDICTION_SECRET: "s".repeat(32),
      ADMIN_E2E_TELEMETRY_INGEST_SECRET: "t".repeat(32),
      ADMIN_E2E_APPROVED_COMMIT_SHA: "a".repeat(40),
      ADMIN_E2E_LOCAL_HEAD_SHA: "a".repeat(40),
      CONVEX_DEPLOYMENT: "dev:safe-preview",
    };
    expect(requireAdminFixtureBoundary(environment)).toBe(true);
    expect(() => requireAdminFixtureBoundary({ ...environment, CONVEX_DEPLOYMENT: "dev:other" }))
      .toThrow(/CONVEX_DEPLOYMENT/);
    expect(() => requireAdminFixtureBoundary({ ...environment, ADMIN_E2E_CONVEX_URL: ` ${environment.ADMIN_E2E_CONVEX_URL}` }))
      .toThrow(/exact/i);
    expect(() => requireAdminFixtureBoundary({ ...environment, ADMIN_E2E_CONVEX_SITE_URL: `${environment.ADMIN_E2E_CONVEX_SITE_URL} ` }))
      .toThrow(/exact/i);
    expect(() => requireAdminFixtureBoundary({ ...environment, ADMIN_E2E_SEARCH_JURISDICTION_SECRET: undefined }))
      .toThrow(/ADMIN_E2E_SEARCH_JURISDICTION_SECRET/);
    expect(() => requireAdminFixtureBoundary({ ...environment, ADMIN_E2E_TELEMETRY_INGEST_SECRET: undefined }))
      .toThrow(/ADMIN_E2E_TELEMETRY_INGEST_SECRET/);
    expect(() => requireAdminFixtureBoundary({ ...environment, ADMIN_E2E_TELEMETRY_INGEST_SECRET: "short" }))
      .toThrow(/too short/i);
  });

  it("exits nonzero with a clear inconclusive result when the session cookie is absent", () => {
    const environment = { ...process.env, ADMIN_E2E_FIXTURE_MODE: undefined };
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/check-admin-budgets.mjs"),
        "--require-session",
      ],
      { encoding: "utf8", env: environment },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "Admin jurisdiction performance is inconclusive",
    );
  });

  it("rejects structural over-caps, provider leakage, and missing calibration", () => {
    const artifact = approvedArtifact();
    Object.assign(artifact.jurisdictionSelector.calibration, { status: "pending", reference: "", outcome: "incomplete" });
    artifact.jurisdictionSelector.profiles[1].resultRowCount = 21;
    artifact.geographicPlacePicker.organizationalPlacesInvocationCount = 1;
    artifact.retrievalPlan.scopeSizeMax = 10;
    artifact.retrievalPlan.planSizeMax = 5;
    artifact.retrievalPlan.storeCountMax = 5;
    artifact.retrievalPlan.unexpectedRealProviderCallCount = 1;
    expect(checkBudgets(artifact)).toEqual(expect.arrayContaining([
      expect.stringMatching(/calibration.*incomplete/i),
      expect.stringMatching(/result rows.*20/i),
      expect.stringMatching(/Organizational.*Places/i),
      expect.stringMatching(/scope.*9/i),
      expect.stringMatching(/plan.*4/i),
      expect.stringMatching(/store.*4/i),
      expect.stringMatching(/unexpected provider/i),
    ]));
  });

  it("rejects unknown versions and secret-bearing artifact fields", () => {
    expect(checkBudgets({ ...approvedArtifact(), artifactVersion: 3, cookie: "secret" }))
      .toEqual(expect.arrayContaining([
        expect.stringMatching(/artifactVersion/i),
        expect.stringMatching(/secret-bearing/i),
      ]));
  });

  it("rejects an unbounded string field", () => {
    expect(checkBudgets({ ...approvedArtifact(), note: "x".repeat(1_001) }))
      .toEqual(expect.arrayContaining([expect.stringMatching(/unbounded/i)]));
  });

  it("rejects missing commit, target, timestamp, browser, device, and network evidence", () => {
    const artifact = approvedArtifact();
    Object.assign(artifact, {
      commitSha: "ABC",
      timestamp: "today",
      targetClass: "production",
      browserProfile: "",
      deviceProfiles: [],
      networkProfiles: [],
    });
    expect(checkBudgets(artifact)).toEqual(expect.arrayContaining([
      expect.stringMatching(/commit/i),
      expect.stringMatching(/timestamp/i),
      expect.stringMatching(/target class/i),
      expect.stringMatching(/browser/i),
      expect.stringMatching(/device/i),
      expect.stringMatching(/network/i),
    ]));
  });

  it("rejects negative, malformed, or aggregate-drifted bounded evidence", () => {
    const artifact = approvedArtifact();
    artifact.geographicPlacePicker.requestCount = 39;
    artifact.geographicPlacePicker.placesInvocationCount = 39;
    artifact.retrievalPlan.scopeSizeMax = -1;
    artifact.retrievalPlan.fileSearchCallCount = 19;
    artifact.retrievalPlan.partialCoverageCount = 1;
    artifact.retrievalPlan.samples[0].fileSearchLatencyMs = Number.POSITIVE_INFINITY;
    artifact.retrievalPlan.samples[0].jurisdictions[0].coverage = "unknown" as never;
    expect(checkBudgets(artifact)).toEqual(expect.arrayContaining([
      expect.stringMatching(/40 requests/i),
      expect.stringMatching(/40 provider invocations/i),
      expect.stringMatching(/non-negative/i),
      expect.stringMatching(/sample schema|structural bounds/i),
      expect.stringMatching(/aggregate/i),
    ]));
  });

  it("requires exact top-level metric snapshots and scalar agreement", () => {
    const artifact = approvedArtifact();
    artifact.lcp = artifact.after.lcp + 1;
    Object.assign(artifact.before, { extra: 1 });
    artifact.delta.inp = 999;
    expect(checkBudgets(artifact)).toEqual(expect.arrayContaining([
      expect.stringMatching(/top-level metrics.*after/i),
      expect.stringMatching(/before.*exact/i),
      expect.stringMatching(/delta.*after minus before/i),
    ]));
  });

  it("rejects semantically inconsistent retrieval observations", () => {
    const artifact = approvedArtifact();
    const sample = artifact.retrievalPlan.samples[0];
    sample.fileSearchCallCount = 0;
    sample.totalLatencyMs = 5;
    sample.jurisdictions[0].relation = "geographic_ancestor" as never;
    expect(checkBudgets(artifact)).toEqual(expect.arrayContaining([
      expect.stringMatching(/call count.*store|sample/i),
      expect.stringMatching(/total latency/i),
      expect.stringMatching(/selected|sample/i),
    ]));
  });

  it("rejects retired or mixed retrieval and calibration fields", () => {
    const mixed = approvedArtifact();
    Object.assign(mixed.retrievalPlan.calibration, { plannerP95LimitMs: 20, plannerOutcome: "pass" });
    Object.assign(mixed.retrievalPlan, { planner: mixed.retrievalPlan.fileSearch, providerCallCount: 20 });
    Object.assign(mixed.retrievalPlan.samples[0], { plannerStatus: "planned", libraries: [] });
    expect(checkBudgets(mixed)).toEqual(expect.arrayContaining([
      "retrievalPlan calibration schema is invalid",
      "retrievalPlan schema is invalid",
      "retrievalPlan sample schema is invalid",
    ]));
  });

  it("rejects retired or mixed fields nested in V2 retrieval distributions", () => {
    const mixed = approvedArtifact();
    Object.assign(mixed.retrievalPlan.fileSearch, { plannerStatus: "planned" });
    Object.assign(mixed.retrievalPlan.total, { peakConcurrency: 2 });

    expect(checkBudgets(mixed)).toEqual(expect.arrayContaining([
      "retrievalPlan File Search distribution schema is invalid",
      "retrievalPlan total distribution schema is invalid",
    ]));
  });

  it("requires explicit calibrated pass outcomes that agree with measured limits", () => {
    const artifact = approvedArtifact();
    artifact.calibratedOutcome = "fail";
    artifact.jurisdictionSelector.profiles[0].outcome = "fail";
    Object.assign(artifact.geographicPlacePicker.calibration, { autocompleteOutcome: "fail" });
    Object.assign(artifact.retrievalPlan.calibration, { totalOutcome: "fail" });
    expect(checkBudgets(artifact)).toEqual(expect.arrayContaining([
      expect.stringMatching(/calibrated outcome.*pass/i),
      expect.stringMatching(/selector.*outcome/i),
      expect.stringMatching(/autocomplete.*outcome/i),
      expect.stringMatching(/retrievalPlan.*total.*outcome/i),
    ]));
  });
});
