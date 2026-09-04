import fs from "node:fs";
import { pathToFileURL } from "node:url";

const METRIC_KEYS = ["lcp", "inp", "cls", "routeJsGzip", "p95"];
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const FORBIDDEN_KEY = /(?:cookie|token|secret|api.?key|claim|question|provider.?body|user.?id|place.?id|address)/i;

/**
 * @param {unknown} metrics
 * @returns {boolean}
 */
function hasExactFiniteMetrics(metrics) {
  return (
    typeof metrics === "object" &&
    metrics !== null &&
    Object.keys(metrics).sort().join("|") === [...METRIC_KEYS].sort().join("|") &&
    METRIC_KEYS.every((key) => Number.isFinite(metrics[key]))
  );
}

function hasFiniteMetricValues(metrics) {
  return typeof metrics === "object" && metrics !== null
    && METRIC_KEYS.every((key) => Number.isFinite(metrics[key]));
}

/** @param {Record<string, unknown>} environment */
export function requireAdminFixtureBoundary(environment = process.env) {
  if (environment.ADMIN_E2E_FIXTURE_MODE !== "true") {
    throw new Error("ADMIN_E2E_FIXTURE_MODE=true is required.");
  }
  if (!['test', 'preview'].includes(environment.ADMIN_E2E_TARGET_ENV)
    || environment.ADMIN_E2E_ISOLATED_TARGET_MARKER !== "isolated-admin-e2e"
    || environment.ADMIN_E2E_PROVIDER_STUB_MODE !== "true"
    || environment.BILLING_ENABLED !== "false") {
    throw new Error("The isolated test/preview fixture boundary with provider stubs and BILLING_ENABLED=false is required.");
  }
  for (const key of ["ADMIN_E2E_CONVEX_URL", "ADMIN_E2E_CONVEX_SITE_URL", "ADMIN_E2E_FIXTURE_SECRET", "ADMIN_E2E_BETTER_AUTH_SECRET", "ADMIN_E2E_ACCOUNT_PASSWORD", "ADMIN_E2E_TELEMETRY_INGEST_SECRET"]) {
    if (typeof environment[key] !== "string" || environment[key].length === 0) throw new Error(`${key} is required.`);
  }
  for (const key of ["ADMIN_E2E_CONVEX_URL", "ADMIN_E2E_CONVEX_SITE_URL"]) {
    if (environment[key] !== environment[key].trim()) throw new Error(`${key} must be supplied as an exact origin without padding.`);
  }
  if (environment.ADMIN_E2E_FIXTURE_SECRET.length < 32 || environment.ADMIN_E2E_BETTER_AUTH_SECRET.length < 32 || environment.ADMIN_E2E_ACCOUNT_PASSWORD.length < 12 || environment.ADMIN_E2E_TELEMETRY_INGEST_SECRET.length < 32) {
    throw new Error("The guarded fixture secrets or account password are too short.");
  }
  if (!SHA_PATTERN.test(environment.ADMIN_E2E_APPROVED_COMMIT_SHA ?? "")
    || environment.ADMIN_E2E_APPROVED_COMMIT_SHA !== environment.ADMIN_E2E_LOCAL_HEAD_SHA) {
    throw new Error("The approved and local commit SHA must match exactly.");
  }
  const backend = new URL(environment.ADMIN_E2E_CONVEX_URL);
  const site = new URL(environment.ADMIN_E2E_CONVEX_SITE_URL);
  for (const url of [backend, site]) {
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Fixture Convex endpoints must be credential-free HTTP(S) origins.");
    }
  }
  const localHosts = ["localhost", "127.0.0.1", "::1", "[::1]"];
  const localBackend = localHosts.includes(backend.hostname);
  const localSite = localHosts.includes(site.hostname);
  if (localBackend !== localSite) throw new Error("Fixture Convex endpoints must identify the same target class.");
  const local = localBackend && localSite;
  if (!local) {
    if (backend.protocol !== "https:" || site.protocol !== "https:"
      || /(?:^|[.-])(?:prod|production|live)(?:[.-]|$)/i.test(`${backend.hostname} ${site.hostname}`)) {
      throw new Error("Remote budget targets must be non-production HTTPS development deployments.");
    }
    const backendName = /^(?<name>[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.convex\.cloud$/.exec(backend.hostname)?.groups?.name;
    const siteName = /^(?<name>[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.convex\.site$/.exec(site.hostname)?.groups?.name;
    if (!backendName || backendName !== siteName || environment.CONVEX_DEPLOYMENT !== `dev:${backendName}`) {
      throw new Error("Remote budget targets require CONVEX_DEPLOYMENT=dev:<deployment-name> matching both Convex origins.");
    }
  }
  return true;
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * fraction) - 1];
}

function distributionFailures(value, label, exactShape = false) {
  const failures = [];
  if (exactShape && !hasExactKeys(value, ["p50Ms", "p95Ms", "samplesMs"])) {
    failures.push(`${label} distribution schema is invalid`);
  }
  if (!value || !Array.isArray(value.samplesMs) || value.samplesMs.length !== 20
    || value.samplesMs.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    failures.push(`${label} must contain exactly 20 finite non-negative samples`);
    return failures;
  }
  if (value.p50Ms !== percentile(value.samplesMs, 0.5) || value.p95Ms !== percentile(value.samplesMs, 0.95)) {
    failures.push(`${label} p50/p95 must match its samples`);
  }
  return failures;
}

function secretBearing(value, depth = 0) {
  if (depth > 12) return true;
  if (typeof value === "string") return value.length > 1_000 || /https?:\/\/|better-auth|\bbearer\b/i.test(value);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.length > 500 || value.some((entry) => secretBearing(entry, depth + 1));
  return Object.entries(value).some(([key, entry]) => FORBIDDEN_KEY.test(key) || secretBearing(entry, depth + 1));
}

function hasExactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function checkCalibration(calibration, label, limits, outcomeKeys = []) {
  if (!hasExactKeys(calibration, ["status", "reference", "outcome", ...limits, ...outcomeKeys])) {
    return [`${label} calibration schema is invalid`];
  }
  if (!calibration || calibration.status !== "approved" || typeof calibration.reference !== "string" || !calibration.reference.trim()) {
    return [`${label} calibration is incomplete`];
  }
  const failures = [];
  if (!limits.every((key) => Number.isFinite(calibration[key]) && calibration[key] >= 0)) {
    failures.push(`${label} calibration limits are missing or non-finite`);
  }
  if (calibration.outcome !== "pass") failures.push(`${label} calibration outcome must explicitly pass`);
  return failures;
}

/** @param {Record<string, unknown>} m */
export function checkBudgets(m) {
  const failures = [];
  if (m.artifactVersion !== 2) failures.push("artifactVersion must be 2");
  if (secretBearing(m)) failures.push("artifact contains a secret-bearing or unbounded field");
  if (!SHA_PATTERN.test(m.commitSha ?? "")) failures.push("commit SHA must be exact lowercase 40-character evidence");
  if (typeof m.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(m.timestamp)
    || !Number.isFinite(Date.parse(m.timestamp))) failures.push("timestamp must be a finite UTC ISO timestamp");
  if (!['test', 'preview'].includes(m.targetClass)) failures.push("target class must be test or preview");
  if (typeof m.browserProfile !== "string" || !m.browserProfile.trim()) failures.push("browser profile evidence is required");
  if (!Array.isArray(m.deviceProfiles) || m.deviceProfiles.length < 2 || m.deviceProfiles.some((entry) => typeof entry !== "string" || !entry)) failures.push("desktop and mobile device profile evidence is required");
  if (!Array.isArray(m.networkProfiles) || m.networkProfiles.length < 2 || m.networkProfiles.some((entry) => typeof entry !== "string" || !entry)) failures.push("unthrottled and throttled network profile evidence is required");
  if (m.baseline !== "authenticated-admin-overview") {
    failures.push("baseline must be authenticated-admin-overview");
  }
  if (m.sampleCount !== 20) {
    failures.push("sampleCount must be exactly 20");
  }
  for (const snapshot of ["before", "after", "delta"]) {
    const value = m[snapshot];
    if (!value || typeof value !== "object" || METRIC_KEYS.some((key) => !Number.isFinite(value[key]))) {
      failures.push(
        `${snapshot} must contain finite lcp, inp, cls, routeJsGzip, and p95 metrics`,
      );
    } else if (!hasExactFiniteMetrics(value)) {
      failures.push(`${snapshot} must contain the exact metric fields only`);
    }
  }

  if (hasExactFiniteMetrics(m.after)
    && METRIC_KEYS.some((key) => m[key] !== m.after[key])) {
    failures.push("top-level metrics must match after exactly");
  }
  if (hasFiniteMetricValues(m.before) && hasFiniteMetricValues(m.after) && hasFiniteMetricValues(m.delta)
    && METRIC_KEYS.some((key) => m.delta[key] !== Number((m.after[key] - m.before[key]).toFixed(6)))) {
    failures.push("delta must equal after minus before exactly");
  }
  if (m.calibratedOutcome !== "pass") failures.push("calibrated outcome must explicitly pass");

  if (hasExactFiniteMetrics(m.after)) {
    failures.push(
      m.after.lcp > 2500 && `LCP ${m.after.lcp}ms exceeds 2500ms`,
      m.after.inp > 200 && `INP ${m.after.inp}ms exceeds 200ms`,
      m.after.cls > 0.1 && `CLS ${m.after.cls} exceeds 0.1`,
      m.after.routeJsGzip > 250_000 &&
        `route JS ${m.after.routeJsGzip} exceeds 250000 bytes`,
      m.after.p95 > 500 && `p95 ${m.after.p95}ms exceeds 500ms`,
    );
  }
  const selector = m.jurisdictionSelector;
  if (!selector || selector.sampleCount !== 20 || !Array.isArray(selector.profiles) || selector.profiles.length !== 4) {
    failures.push("jurisdictionSelector must contain four exact 20-sample profiles");
  } else {
    failures.push(...checkCalibration(selector.calibration, "jurisdictionSelector", []));
    const expected = ["off:desktop", "on:desktop", "on:mobile", "on:throttled"];
    if (selector.profiles.map((profile) => `${profile.flagState}:${profile.profile}`).join("|") !== expected.join("|")) {
      failures.push("jurisdictionSelector profiles must be flag-off desktop then flag-on desktop/mobile/throttled");
    }
    for (const profile of selector.profiles) {
      failures.push(...distributionFailures(profile, `jurisdictionSelector ${profile.flagState}/${profile.profile}`));
      if (!Number.isSafeInteger(profile.resultRowCount) || profile.resultRowCount < 0 || profile.resultRowCount > 20) failures.push("jurisdictionSelector result rows must not exceed 20");
      if (!Number.isFinite(profile.flagOffBaselineDeltaMs)) failures.push("jurisdictionSelector baseline delta must be finite");
      if (!Number.isFinite(profile.approvedP95LimitMs)) failures.push("jurisdictionSelector approved p95 limit is missing");
      else if (Number.isFinite(profile.p95Ms) && profile.p95Ms > profile.approvedP95LimitMs) failures.push(`jurisdictionSelector ${profile.profile} p95 exceeds its approved calibration`);
      const expectedOutcome = Number.isFinite(profile.p95Ms) && Number.isFinite(profile.approvedP95LimitMs) && profile.p95Ms <= profile.approvedP95LimitMs ? "pass" : "fail";
      if (profile.outcome !== expectedOutcome || profile.outcome !== "pass") failures.push(`jurisdictionSelector ${profile.profile} outcome must match its calibrated pass/fail result`);
    }
  }
  const picker = m.geographicPlacePicker;
  if (!picker || picker.sampleCount !== 20) failures.push("geographicPlacePicker sampleCount must be exactly 20");
  else {
    failures.push(...checkCalibration(picker.calibration, "geographicPlacePicker", ["autocompleteP95LimitMs", "detailsP95LimitMs"], ["autocompleteOutcome", "detailsOutcome"]));
    failures.push(...distributionFailures(picker.autocomplete, "geographicPlacePicker autocomplete"));
    failures.push(...distributionFailures(picker.details, "geographicPlacePicker details"));
    if (!Number.isSafeInteger(picker.resultCount) || picker.resultCount < 0 || picker.resultCount > 20) failures.push("geographicPlacePicker result count must be within 20");
    if (picker.branch !== "geographic") failures.push("geographicPlacePicker branch must be geographic");
    if (picker.requestCount !== 40) failures.push("geographicPlacePicker must record exactly 40 requests");
    if (picker.placesInvocationCount !== 40) failures.push("geographicPlacePicker must record exactly 40 provider invocations");
    if (picker.sameSessionCorrelation !== true) failures.push("geographicPlacePicker autocomplete/details must use the same session");
    if (picker.organizationalPlacesInvocationCount !== 0) failures.push("Organizational selection must make zero Places requests");
    if (Number.isFinite(picker.autocomplete?.p95Ms) && Number.isFinite(picker.calibration?.autocompleteP95LimitMs) && picker.autocomplete.p95Ms > picker.calibration.autocompleteP95LimitMs) failures.push("geographicPlacePicker autocomplete p95 exceeds calibration");
    if (Number.isFinite(picker.details?.p95Ms) && Number.isFinite(picker.calibration?.detailsP95LimitMs) && picker.details.p95Ms > picker.calibration.detailsP95LimitMs) failures.push("geographicPlacePicker details p95 exceeds calibration");
    const autocompleteOutcome = Number.isFinite(picker.autocomplete?.p95Ms) && Number.isFinite(picker.calibration?.autocompleteP95LimitMs) && picker.autocomplete.p95Ms <= picker.calibration.autocompleteP95LimitMs ? "pass" : "fail";
    const detailsOutcome = Number.isFinite(picker.details?.p95Ms) && Number.isFinite(picker.calibration?.detailsP95LimitMs) && picker.details.p95Ms <= picker.calibration.detailsP95LimitMs ? "pass" : "fail";
    if (picker.calibration?.autocompleteOutcome !== autocompleteOutcome || picker.calibration?.autocompleteOutcome !== "pass") failures.push("geographicPlacePicker autocomplete outcome must match its calibrated pass/fail result");
    if (picker.calibration?.detailsOutcome !== detailsOutcome || picker.calibration?.detailsOutcome !== "pass") failures.push("geographicPlacePicker details outcome must match its calibrated pass/fail result");
  }
  return failures.filter((failure) => typeof failure === "string");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--require-session") {
    try {
      requireAdminFixtureBoundary();
    } catch (error) {
      console.error(`Admin jurisdiction performance is inconclusive: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    }
  } else {
    try {
      const artifactPath = process.argv[2] ?? "artifacts/admin-performance.json";
      if (fs.statSync(artifactPath).size > 2_000_000) throw new Error("Performance artifact exceeds its bounded size.");
      const metrics = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      const failures = checkBudgets(metrics);
      if (failures.length) {
        console.error(failures.join("\n"));
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(
        `Admin performance budgets are inconclusive: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exitCode = 2;
    }
  }
}
