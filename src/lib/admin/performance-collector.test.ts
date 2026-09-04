import { describe, expect, it } from "vitest";
import {
  adminOnlyScriptBytes,
  buildAdminSliceArtifact,
  buildJurisdictionPerformanceSections,
  percentile95,
  validatePerformanceCalibration,
} from "../../../scripts/admin-performance-collector.mjs";

describe("admin performance collector", () => {
  it("validates the selector and Places calibration shape", () => {
    const approved = {
      reference: "approved-change-42",
      selectorP95LimitsMs: [10, 20, 30, 40],
      autocompleteP95LimitMs: 50,
      detailsP95LimitMs: 60,
    };
    expect(validatePerformanceCalibration(approved)).toEqual(approved);
    expect(() => validatePerformanceCalibration({
      ...approved,
      fileSearchP95LimitMs: 70,
    })).toThrow(/calibration/i);
  });

  it("calculates p95 from exactly twenty bounded request samples", () => {
    expect(percentile95([
      20, 1, 19, 2, 18, 3, 17, 4, 16, 5,
      15, 6, 14, 7, 13, 8, 12, 9, 11, 10,
    ])).toBe(19);
  });

  it("counts only scripts introduced by the admin route", () => {
    expect(adminOnlyScriptBytes(
      [
        { url: "/_next/static/shared.js", encodedBodySize: 1_000 },
        { url: "/_next/static/public.js", encodedBodySize: 300 },
      ],
      [
        { url: "/_next/static/shared.js", encodedBodySize: 1_000 },
        { url: "/_next/static/admin.js", encodedBodySize: 2_648 },
      ],
    )).toBe(2_648);
  });

  it("builds a finite before-and-after artifact with explicit deltas", () => {
    const before = { lcp: 2_000, inp: 120, cls: 0.04, routeJsGzip: 100_000, p95: 300 };
    const after = { lcp: 2_100, inp: 130, cls: 0.05, routeJsGzip: 2_648, p95: 320 };
    expect(buildAdminSliceArtifact(before, after, {
      commitSha: "abc123",
      timestamp: "2026-07-23T00:00:00.000Z",
      sampleCount: 20,
    })).toEqual({
      artifactVersion: 2,
      ...after,
      baseline: "authenticated-admin-overview",
      baselineDescription:
        "Authenticated /admin server render with bounded overview queries; route JavaScript excludes scripts already loaded by the public baseline.",
      before: { ...before, routeJsGzip: 0 },
      after,
      delta: { lcp: 100, inp: 10, cls: 0.01, routeJsGzip: 2_648, p95: 20 },
      commitSha: "abc123",
      timestamp: "2026-07-23T00:00:00.000Z",
      sampleCount: 20,
    });
  });

  it("builds bounded selector and Places distributions from exact samples", () => {
    const durations = Array.from({ length: 20 }, (_value, index) => index + 1);
    const sections = buildJurisdictionPerformanceSections({
      selectorProfiles: [
        { flagState: "off", profile: "desktop", resultRowCount: 1, samplesMs: durations, baselineP95Ms: 19 },
        { flagState: "on", profile: "desktop", resultRowCount: 4, samplesMs: durations, baselineP95Ms: 19 },
        { flagState: "on", profile: "mobile", resultRowCount: 4, samplesMs: durations, baselineP95Ms: 19 },
        { flagState: "on", profile: "throttled", resultRowCount: 4, samplesMs: durations, baselineP95Ms: 19 },
      ],
      placePicker: {
        branch: "geographic",
        autocompleteSamplesMs: durations,
        detailsSamplesMs: durations,
        resultCount: 1,
        requestCount: 40,
        sameSessionCorrelation: true,
        placesInvocationCount: 40,
      },
      organizationalPlacesInvocationCount: 0,
    });
    expect(sections).toMatchObject({
      jurisdictionSelector: { sampleCount: 20 },
      geographicPlacePicker: { sampleCount: 20, sameSessionCorrelation: true },
    });
    expect(sections).not.toHaveProperty("retrievalPlan");
    expect(sections.jurisdictionSelector.profiles[0]).toMatchObject({ p50Ms: 10, p95Ms: 19 });
  });
});
