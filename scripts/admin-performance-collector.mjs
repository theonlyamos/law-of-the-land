import { assertFiniteMetrics } from "./admin-performance-artifact.mjs";

const METRIC_KEYS = ["lcp", "inp", "cls", "routeJsGzip", "p95"];
const CALIBRATION_KEYS = [
  "autocompleteP95LimitMs",
  "detailsP95LimitMs",
  "reference",
  "selectorP95LimitsMs",
];

export function validatePerformanceCalibration(value) {
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  const numbers = value && typeof value === "object"
    ? [...(Array.isArray(value.selectorP95LimitsMs) ? value.selectorP95LimitsMs : []),
      value.autocompleteP95LimitMs, value.detailsP95LimitMs]
    : [];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || keys.join("|") !== [...CALIBRATION_KEYS].sort().join("|")
    || typeof value.reference !== "string" || !value.reference.trim() || value.reference.length > 200
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value.reference)
    || !Array.isArray(value.selectorP95LimitsMs) || value.selectorP95LimitsMs.length !== 4
    || numbers.some((entry) => !Number.isFinite(entry) || entry < 0)) {
    throw new Error("Approved performance calibration file is invalid.");
  }
  return value;
}

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
