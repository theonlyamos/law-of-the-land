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
  });
  Object.assign(sections.jurisdictionSelector.calibration, {
    status: "approved", reference: "change-record-123", outcome: "pass",
  });
  for (const profile of sections.jurisdictionSelector.profiles) {
    Object.assign(profile, { approvedP95LimitMs: 20, outcome: "pass" });
  }
  Object.assign(sections.geographicPlacePicker.calibration, {
    status: "approved",
    reference: "change-record-123",
    autocompleteP95LimitMs: 20,
    detailsP95LimitMs: 20,
    autocompleteOutcome: "pass",
    detailsOutcome: "pass",
    outcome: "pass",
  });
  return sections;
}

function approvedArtifact() {
  const before = { lcp: 2300, inp: 170, cls: 0.04, routeJsGzip: 0, p95: 430 };
  const after = { lcp: 2400, inp: 180, cls: 0.05, routeJsGzip: 240_000, p95: 450 };
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
    delta: { lcp: 100, inp: 10, cls: 0.01, routeJsGzip: 240_000, p95: 20 },
    ...approvedSections(),
  };
}

describe("admin performance budgets", () => {
  it("accepts the approved selector and Places limits", () => {
    expect(checkBudgets(approvedArtifact())).toEqual([]);
  });

  it("requires the complete guarded fixture boundary", () => {
    expect(() => requireAdminFixtureBoundary({})).toThrow("ADMIN_E2E_FIXTURE_MODE=true");
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
      ADMIN_E2E_TELEMETRY_INGEST_SECRET: "t".repeat(32),
      ADMIN_E2E_APPROVED_COMMIT_SHA: "a".repeat(40),
      ADMIN_E2E_LOCAL_HEAD_SHA: "a".repeat(40),
      CONVEX_DEPLOYMENT: "dev:safe-preview",
    };
    expect(requireAdminFixtureBoundary(environment)).toBe(true);
    expect(() => requireAdminFixtureBoundary({ ...environment, CONVEX_DEPLOYMENT: "dev:other" }))
      .toThrow(/CONVEX_DEPLOYMENT/);
    expect(() => requireAdminFixtureBoundary({
      ...environment,
      ADMIN_E2E_TELEMETRY_INGEST_SECRET: undefined,
    })).toThrow(/ADMIN_E2E_TELEMETRY_INGEST_SECRET/);
  });

  it("rejects calibration, shape, and leakage failures", () => {
    const artifact = approvedArtifact();
    Object.assign(artifact.jurisdictionSelector.calibration, {
      status: "pending", reference: "", outcome: "incomplete",
    });
    artifact.jurisdictionSelector.profiles[1].resultRowCount = 21;
    artifact.geographicPlacePicker.organizationalPlacesInvocationCount = 1;
    Object.assign(artifact, { cookie: "secret" });
    expect(checkBudgets(artifact)).toEqual(expect.arrayContaining([
      expect.stringMatching(/calibration.*incomplete/i),
      expect.stringMatching(/result rows.*20/i),
      expect.stringMatching(/Organizational.*Places/i),
      expect.stringMatching(/secret-bearing/i),
    ]));
  });

  it("requires exact metric snapshots and matching deltas", () => {
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

  it("exits inconclusive when the fixture boundary is absent", () => {
    const result = spawnSync(process.execPath, [
      path.resolve("scripts/check-admin-budgets.mjs"),
      "--require-session",
    ], {
      encoding: "utf8",
      env: { ...process.env, ADMIN_E2E_FIXTURE_MODE: undefined },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Admin jurisdiction performance is inconclusive");
  });
});
