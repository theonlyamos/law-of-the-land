import { describe, expect, it } from "vitest";
import {
  adminOnlyScriptBytes,
  buildAdminSliceArtifact,
  buildJurisdictionPerformanceSections,
  collectPacedRetrievalObservations,
  collectRetrievalObservation,
  percentile95,
} from "../../../scripts/admin-performance-collector.mjs";
import { encodeRetrievalObservationV1Value } from "../../../shared/e2e-jurisdiction-provider-contract";

describe("admin performance collector", () => {
  it("opens a clean process rate window before collecting exactly twenty paced retrieval samples", async () => {
    const waits: number[] = [];
    const calls: number[] = [];
    const observations = await collectPacedRetrievalObservations({
      collect: async (index: number) => {
        calls.push(index);
        return { index };
      },
      wait: async (milliseconds: number) => {
        waits.push(milliseconds);
      },
    });

    expect(calls).toEqual(Array.from({ length: 20 }, (_value, index) => index));
    expect(observations).toHaveLength(20);
    expect(waits).toEqual([60_000, ...Array(19).fill(4_100)]);
  });

  it("aborts a failed retrieval sample without retrying or padding the sample set", async () => {
    const calls: number[] = [];
    await expect(collectPacedRetrievalObservations({
      collect: async (index: number) => {
        calls.push(index);
        if (index === 3) throw new Error("failed sample");
        return { index };
      },
      wait: async () => undefined,
    })).rejects.toThrow("failed sample");
    expect(calls).toEqual([0, 1, 2, 3]);
  });

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

  it("builds bounded selector, picker, and retrieval distributions from exactly twenty samples", () => {
    const durations = Array.from({ length: 20 }, (_value, index) => index + 1);
    const observation = {
      version: 1 as const,
      planner: { status: "planned" as const, latencyMs: 2 },
      authorizedScopeSize: 3,
      planSize: 3,
      peakConcurrency: 2,
      totalLatencyMs: 7,
      libraries: [
        { ordinal: 0 as const, relation: "selected" as const, status: "fulfilled" as const, latencyMs: 3 },
        { ordinal: 1 as const, relation: "organizational_geography" as const, status: "fulfilled" as const, latencyMs: 4 },
        { ordinal: 2 as const, relation: "geographic_ancestor" as const, status: "fulfilled" as const, latencyMs: 3 },
      ],
      failureCount: 0,
      coverageState: "complete" as const,
      providerCallCount: 3,
      unexpectedRealProviderCallCount: 0 as const,
    };

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
      retrievalObservations: Array.from({ length: 20 }, () => observation),
    });
    expect(sections).toMatchObject({
      jurisdictionSelector: { sampleCount: 20 },
      geographicPlacePicker: { sampleCount: 20, sameSessionCorrelation: true },
      retrievalPlan: { sampleCount: 20, scopeSizeMax: 3, planSizeMax: 3, concurrencyPeak: 2 },
    });
    expect(sections.jurisdictionSelector.profiles[0]).toMatchObject({ p50Ms: 10, p95Ms: 19 });
  });

  it("collects and strictly decodes the parent-only observation header", async () => {
    const encoded = encodeRetrievalObservationV1Value({
      version: 1,
      planner: { status: "planned", latencyMs: 1 },
      authorizedScopeSize: 1,
      planSize: 1,
      peakConcurrency: 1,
      totalLatencyMs: 2,
      libraries: [{ ordinal: 0, relation: "selected", status: "fulfilled", latencyMs: 1 }],
      failureCount: 0,
      coverageState: "complete",
      providerCallCount: 1,
      unexpectedRealProviderCallCount: 0,
    });
    const request = async (_url: string | URL | Request, init?: RequestInit) => {
      if (!init) throw new Error("request initialization missing");
      expect(init.headers).toEqual({
        "content-type": "application/json",
        cookie: "better-auth.session_token=signed",
        "x-admin-e2e-provider-observation": "parent-only-secret",
      });
      return new Response(JSON.stringify({ result: "bounded" }), {
        status: 200,
        headers: { "x-admin-e2e-retrieval-plan-v1": encoded },
      });
    };
    await expect(collectRetrievalObservation({
      url: "http://127.0.0.1:3000/api/search",
      cookie: "better-auth.session_token=signed",
      observationSecret: "parent-only-secret",
      body: { query: "exact", jurisdictionId: "opaque" },
      request,
    })).resolves.toEqual(expect.objectContaining({ version: 1, planSize: 1 }));
    await expect(collectRetrievalObservation({
      url: "http://127.0.0.1:3000/api/search",
      cookie: "better-auth.session_token=signed",
      observationSecret: "parent-only-secret",
      body: {},
      request: async () => new Response("{}", { status: 200 }),
    })).rejects.toThrow(/observation/i);
    await expect(collectRetrievalObservation({
      url: "http://127.0.0.1:3000/api/search",
      cookie: "better-auth.session_token=signed",
      observationSecret: "parent-only-secret",
      body: {},
      request: async () => new Response("quota", {
        status: 429,
        headers: { "x-admin-e2e-retrieval-plan-v1": encoded },
      }),
    })).rejects.toThrow(/status 429/i);
  });
});
