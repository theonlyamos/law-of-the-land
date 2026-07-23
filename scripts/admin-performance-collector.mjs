import { assertFiniteMetrics } from "./admin-performance-artifact.mjs";

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
