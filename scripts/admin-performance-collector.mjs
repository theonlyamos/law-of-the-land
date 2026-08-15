import { assertFiniteMetrics } from "./admin-performance-artifact.mjs";
import { decodeRetrievalObservationV1 } from "../shared/e2e-jurisdiction-provider-contract.ts";

const METRIC_KEYS = ["lcp", "inp", "cls", "routeJsGzip", "p95"];

export function percentile95(values) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new TypeError("p95 samples must be a non-empty array of finite numbers.");
  }
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

export function percentile50(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new TypeError("p50 samples must be a non-empty array of finite numbers.");
  }
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.5) - 1];
}

function exactTwenty(values, label) {
  if (!Array.isArray(values) || values.length !== 20
    || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new TypeError(`${label} requires exactly 20 finite non-negative samples.`);
  }
  return [...values];
}

function distribution(values, label) {
  const samplesMs = exactTwenty(values, label);
  return { samplesMs, p50Ms: percentile50(samplesMs), p95Ms: percentile95(samplesMs) };
}

export async function collectRetrievalObservation({ url, cookie, observationSecret, body, request = fetch }) {
  const response = await request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      "x-admin-e2e-provider-observation": observationSecret,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Authorized collection failed with status ${response.status}; no sample was recorded.`);
  }
  const encoded = response.headers.get("x-admin-e2e-retrieval-plan-v1");
  if (!encoded) throw new Error("Authorized collection response omitted its retrieval observation.");
  return decodeRetrievalObservationV1(encoded);
}

export async function collectPacedRetrievalObservations({
  collect,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (typeof collect !== "function" || typeof wait !== "function") {
    throw new TypeError("Paced retrieval collection requires collect and wait functions.");
  }
  await wait(60_000);
  const observations = [];
  for (let index = 0; index < 20; index += 1) {
    if (index > 0) await wait(4_100);
    observations.push(await collect(index));
  }
  return observations;
}

export function buildJurisdictionPerformanceSections(input) {
  if (!Array.isArray(input.selectorProfiles) || input.selectorProfiles.length !== 4) {
    throw new TypeError("Jurisdiction selector requires the four approved collection profiles.");
  }
  const profiles = input.selectorProfiles.map((profile) => {
    const metrics = distribution(profile.samplesMs, "Jurisdiction selector");
    if (!Number.isSafeInteger(profile.resultRowCount) || profile.resultRowCount < 0 || profile.resultRowCount > 20) {
      throw new TypeError("Jurisdiction selector result rows must be bounded to 20.");
    }
    if (!Number.isFinite(profile.baselineP95Ms)) throw new TypeError("Jurisdiction selector baseline must be finite.");
    return {
      flagState: profile.flagState,
      profile: profile.profile,
      resultRowCount: profile.resultRowCount,
      ...metrics,
      flagOffBaselineDeltaMs: Number((metrics.p95Ms - profile.baselineP95Ms).toFixed(6)),
    };
  });
  const autocomplete = distribution(input.placePicker.autocompleteSamplesMs, "Places autocomplete");
  const details = distribution(input.placePicker.detailsSamplesMs, "Places details");
  const observations = input.retrievalObservations;
  if (!Array.isArray(observations) || observations.length !== 20) {
    throw new TypeError("Retrieval planning requires exactly 20 decoded observations.");
  }
  const plannerSamples = observations.map((entry) => entry.planner.latencyMs);
  const totalSamples = observations.map((entry) => entry.totalLatencyMs);
  return {
    jurisdictionSelector: {
      sampleCount: 20,
      calibration: { status: "pending", outcome: "incomplete" },
      profiles,
    },
    geographicPlacePicker: {
      sampleCount: 20,
      calibration: { status: "pending", outcome: "incomplete" },
      branch: input.placePicker.branch,
      autocomplete,
      details,
      resultCount: input.placePicker.resultCount,
      requestCount: input.placePicker.requestCount,
      sameSessionCorrelation: input.placePicker.sameSessionCorrelation,
      placesInvocationCount: input.placePicker.placesInvocationCount,
      organizationalPlacesInvocationCount: input.organizationalPlacesInvocationCount,
    },
    retrievalPlan: {
      sampleCount: 20,
      calibration: { status: "pending", outcome: "incomplete" },
      planner: {
        ...distribution(plannerSamples, "Retrieval planner"),
        plannedCount: observations.filter((entry) => entry.planner.status === "planned").length,
        fallbackCount: observations.filter((entry) => entry.planner.status === "fallback").length,
      },
      total: distribution(totalSamples, "Retrieval total"),
      scopeSizeMax: Math.max(...observations.map((entry) => entry.authorizedScopeSize)),
      planSizeMax: Math.max(...observations.map((entry) => entry.planSize)),
      concurrencyPeak: Math.max(...observations.map((entry) => entry.peakConcurrency)),
      failureCount: observations.reduce((total, entry) => total + entry.failureCount, 0),
      providerCallCount: observations.reduce((total, entry) => total + entry.providerCallCount, 0),
      unexpectedRealProviderCallCount: observations.reduce((total, entry) => total + entry.unexpectedRealProviderCallCount, 0),
      coverageStates: {
        complete: observations.filter((entry) => entry.coverageState === "complete").length,
        supplementary_incomplete: observations.filter((entry) => entry.coverageState === "supplementary_incomplete").length,
        selected_unavailable: observations.filter((entry) => entry.coverageState === "selected_unavailable").length,
      },
      samples: observations.map((entry) => ({
        plannerStatus: entry.planner.status,
        plannerLatencyMs: entry.planner.latencyMs,
        authorizedScopeSize: entry.authorizedScopeSize,
        planSize: entry.planSize,
        peakConcurrency: entry.peakConcurrency,
        libraries: entry.libraries,
        totalLatencyMs: entry.totalLatencyMs,
        failureCount: entry.failureCount,
        coverageState: entry.coverageState,
        providerCallCount: entry.providerCallCount,
        unexpectedRealProviderCallCount: entry.unexpectedRealProviderCallCount,
      })),
    },
  };
}

export function adminOnlyScriptBytes(publicScripts, adminScripts) {
  const publicUrls = new Set(publicScripts.map((script) => script.url));
  return adminScripts.reduce((total, script) => {
    if (
      publicUrls.has(script.url) ||
      !Number.isFinite(script.encodedBodySize) ||
      script.encodedBodySize < 0
    ) {
      return total;
    }
    return total + script.encodedBodySize;
  }, 0);
}

function metricSnapshot(metrics) {
  assertFiniteMetrics(metrics);
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, metrics[key]]));
}

function preciseDelta(after, before) {
  return Number((after - before).toFixed(6));
}

export function buildAdminSliceArtifact(beforeInput, afterInput, metadata) {
  const before = metricSnapshot({ ...beforeInput, routeJsGzip: 0 });
  const after = metricSnapshot(afterInput);
  if (metadata.sampleCount !== 20) {
    throw new TypeError("Authenticated admin performance requires exactly 20 request samples.");
  }

  const delta = Object.fromEntries(
    METRIC_KEYS.map((key) => [key, preciseDelta(after[key], before[key])]),
  );

  return {
    artifactVersion: 2,
    ...after,
    baseline: "authenticated-admin-overview",
    baselineDescription:
      "Authenticated /admin server render with bounded overview queries; route JavaScript excludes scripts already loaded by the public baseline.",
    before,
    after,
    delta,
    commitSha: metadata.commitSha,
    timestamp: metadata.timestamp,
    sampleCount: metadata.sampleCount,
  };
}
