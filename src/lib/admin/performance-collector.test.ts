import { describe, expect, it } from "vitest";
import {
  adminOnlyScriptBytes,
  buildAdminSliceArtifact,
  percentile95,
} from "../../../scripts/admin-performance-collector.mjs";

describe("admin performance collector", () => {
  it("calculates p95 from exactly twenty bounded request samples", () => {
    expect(percentile95([20, 1, 19, 2, 18, 3, 17, 4, 16, 5, 15, 6, 14, 7, 13, 8, 12, 9, 11, 10])).toBe(19);
  });

  it("counts only scripts introduced by the admin route", () => {
    expect(
      adminOnlyScriptBytes(
        [
          { url: "/_next/static/shared.js", encodedBodySize: 1_000 },
          { url: "/_next/static/public.js", encodedBodySize: 300 },
        ],
        [
          { url: "/_next/static/shared.js", encodedBodySize: 1_000 },
          { url: "/_next/static/admin.js", encodedBodySize: 2_648 },
        ],
      ),
    ).toBe(2_648);
  });

  it("builds a finite before-and-after artifact with explicit deltas", () => {
    const before = {
      lcp: 2_000,
      inp: 120,
      cls: 0.04,
      routeJsGzip: 100_000,
      p95: 300,
    };
    const after = {
      lcp: 2_100,
      inp: 130,
      cls: 0.05,
      routeJsGzip: 2_648,
      p95: 320,
    };

    expect(
      buildAdminSliceArtifact(before, after, {
        commitSha: "abc123",
        timestamp: "2026-07-23T00:00:00.000Z",
        sampleCount: 20,
      }),
    ).toEqual({
      ...after,
      baseline: "authenticated-admin-overview",
      baselineDescription:
        "Authenticated /admin server render with bounded overview queries; route JavaScript excludes scripts already loaded by the public baseline.",
      before,
      after,
      delta: { lcp: 100, inp: 10, cls: 0.01, routeJsGzip: -97_352, p95: 20 },
      commitSha: "abc123",
      timestamp: "2026-07-23T00:00:00.000Z",
      sampleCount: 20,
    });
  });
});
