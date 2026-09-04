import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readPerformanceArtifact, removePerformanceArtifacts, writePerformanceArtifact } from "../scripts/admin-performance-artifact.mjs";
import { adminOnlyScriptBytes, buildAdminSliceArtifact, buildJurisdictionPerformanceSections, percentile95, validatePerformanceCalibration } from "../scripts/admin-performance-collector.mjs";
import { controlBrowserFixtures, installSessionCookie, loadBrowserFixtureManifest, type BrowserFixtureManifest } from "./admin/fixtures";

type ScriptResource = { url: string; encodedBodySize: number };
type BrowserMetrics = { lcp: number; inp: number | null; cls: number; routeJsGzip: number; scriptResources: ScriptResource[]; interactionEntries: number };
type CalibrationInput = {
  reference: string;
  selectorP95LimitsMs: [number, number, number, number];
  autocompleteP95LimitMs: number;
  detailsP95LimitMs: number;
};

const artifactPath = path.resolve("artifacts/admin-performance.json");
const publicBaselineArtifactPath = path.resolve("test-results/admin-performance-public-baseline.json");

type PlaceDetailsResponse = {
  place: {
    placeId: string;
    displayName: string;
    formattedAddress: string;
    latitude: number;
    longitude: number;
    countryCode?: string;
  };
  verifiedPlaceClaim: string;
};

test.describe.configure({ mode: "serial" });
const temporaryArtifactPaths = [publicBaselineArtifactPath];
test.beforeAll(() => removePerformanceArtifacts(temporaryArtifactPaths));
test.afterAll(() => removePerformanceArtifacts(temporaryArtifactPaths));

async function installPerformanceObservers(page: Page) {
  await page.addInitScript(() => {
    const metrics = { lcp: 0, inp: null as number | null, cls: 0, interactionEntries: 0 };
    Object.assign(window, { __adminPerformanceMetrics: metrics });
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) metrics.lcp = Math.max(metrics.lcp, entry.startTime);
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries() as PerformanceEntryList & Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
        if (!entry.hadRecentInput) metrics.cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        if (entry.name === "click" || entry.name === "keydown") {
          metrics.inp = Math.max(metrics.inp ?? 0, entry.duration);
          metrics.interactionEntries += 1;
        }
      }
    }).observe({ type: "event", buffered: true, durationThreshold: 0 } as PerformanceObserverInit & { durationThreshold: number });
  });
}

async function readBrowserMetrics(page: Page): Promise<BrowserMetrics> {
  return await page.evaluate(() => {
    const observed = (window as unknown as Window & { __adminPerformanceMetrics: BrowserMetrics }).__adminPerformanceMetrics;
    const scriptResources = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .filter((entry) => entry.initiatorType === "script" && new URL(entry.name).origin === location.origin)
      .map((entry) => ({ url: new URL(entry.name).pathname, encodedBodySize: entry.encodedBodySize }));
    return { ...observed, routeJsGzip: scriptResources.reduce((total, entry) => total + entry.encodedBodySize, 0), scriptResources };
  });
}

async function createMeasuredInteraction(page: Page, target: "public" | "admin") {
  const element = target === "public"
    ? page.getByRole("link", { name: "Jurisdictions", exact: true })
    : page.getByRole("button", { name: "Collapse administration navigation" });
  await expect(element).toBeVisible();
  await expect(element).toBeEnabled();
  await element.click();
  if (target === "public") await expect(page).toHaveURL(/#jurisdictions$/);
  else await expect(page.getByRole("button", { name: "Expand administration navigation" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as Window & { __adminPerformanceMetrics: { interactionEntries: number } }).__adminPerformanceMetrics.interactionEntries)).toBeGreaterThan(0);
}

async function collectSelectorProfile(page: Page, fixture: BrowserFixtureManifest, profile: "desktop" | "mobile" | "throttled", enabled: boolean) {
  await controlBrowserFixtures(fixture, "set_unified_jurisdictions_flag", { enabled });
  await page.setViewportSize(profile === "mobile" ? { width: 390, height: 844 } : { width: 1280, height: 900 });
  const cdp = profile === "throttled" ? await page.context().newCDPSession(page) : null;
  if (cdp) {
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8 });
  }
  try {
    await page.goto("/");
    const samplesMs: number[] = [];
    await page.getByRole("radio", { name: "Organizational" }).click();
    const selector = page.getByRole("combobox", { name: "Find jurisdiction" });
    const expected = page.getByRole("option", { name: new RegExp(`${fixture.tag} Public Organization, Organizational`) });
    for (let index = 0; index < 20; index += 1) {
      await selector.fill("");
      const startedAt = performance.now();
      await selector.fill(`${fixture.tag} Public Organization`);
      await expect(expected).toBeVisible();
      samplesMs.push(performance.now() - startedAt);
    }
    const resultRowCount = await page.getByRole("listbox", { name: "Jurisdiction results" }).getByRole("option").count();
    return { samplesMs, resultRowCount };
  } finally {
    if (cdp) await cdp.detach();
  }
}

async function verifyStubPlaceClaim(details: PlaceDetailsResponse, fixture: BrowserFixtureManifest) {
  const result = await controlBrowserFixtures(fixture, "verify_place_claim", {
    claim: details.verifiedPlaceClaim,
  });
  expect(result).toEqual({
    ok: true,
    place: {
      googlePlaceId: details.place.placeId,
      name: "Accra",
      formattedAddress: "Accra, Ghana",
      latitude: 5.6037,
      longitude: -0.187,
      countryCode: "GH",
      aliases: ["accra", "gh", "ghana", "greater accra", "greater accra region"],
    },
  });
}

async function collectPlacePicker(request: APIRequestContext, cookie: string, fixture: BrowserFixtureManifest) {
  const autocompleteSamplesMs: number[] = [];
  const detailsSamplesMs: number[] = [];
  let resultCount = 0;
  for (let index = 0; index < 20; index += 1) {
    const sessionToken = crypto.randomUUID();
    let startedAt = performance.now();
    const autocomplete = await request.post("/api/admin/geographic-places/autocomplete", { headers: { cookie }, data: { input: "Accra", sessionToken } });
    autocompleteSamplesMs.push(performance.now() - startedAt);
    expect(autocomplete.status()).toBe(200);
    const suggestions = (await autocomplete.json() as { suggestions: Array<{ placeId: string }> }).suggestions;
    expect(suggestions.length).toBeGreaterThan(0);
    resultCount = Math.max(resultCount, suggestions.length);
    startedAt = performance.now();
    const details = await request.post("/api/admin/geographic-places/details", { headers: { cookie }, data: { placeId: suggestions[0].placeId, sessionToken } });
    detailsSamplesMs.push(performance.now() - startedAt);
    expect(details.status()).toBe(200);
    if (index === 0) await verifyStubPlaceClaim(await details.json() as PlaceDetailsResponse, fixture);
  }
  return { branch: "geographic", autocompleteSamplesMs, detailsSamplesMs, resultCount, requestCount: 40, sameSessionCorrelation: true, placesInvocationCount: 40 };
}

function approvedCalibration(): CalibrationInput | null {
  const calibrationPath = process.env.ADMIN_E2E_PERFORMANCE_CALIBRATION_FILE;
  if (!calibrationPath) return null;
  if (fs.statSync(calibrationPath).size > 16_384) {
    throw new Error("Approved performance calibration file exceeds its bounded size.");
  }
  return validatePerformanceCalibration(JSON.parse(fs.readFileSync(calibrationPath, "utf8"))) as CalibrationInput;
}

function applyCalibration(sections: ReturnType<typeof buildJurisdictionPerformanceSections>, calibration: CalibrationInput | null) {
  if (!calibration) return sections;
  const selectorOutcomes = sections.jurisdictionSelector.profiles.map((profile: { p95Ms: number }, index: number) => {
    const outcome = profile.p95Ms <= calibration.selectorP95LimitsMs[index] ? "pass" : "fail";
    Object.assign(profile, { approvedP95LimitMs: calibration.selectorP95LimitsMs[index], outcome });
    return outcome;
  });
  Object.assign(sections.jurisdictionSelector.calibration, { status: "approved", reference: calibration.reference, outcome: selectorOutcomes.every((outcome: string) => outcome === "pass") ? "pass" : "fail" });
  const autocompleteOutcome = sections.geographicPlacePicker.autocomplete.p95Ms <= calibration.autocompleteP95LimitMs ? "pass" : "fail";
  const detailsOutcome = sections.geographicPlacePicker.details.p95Ms <= calibration.detailsP95LimitMs ? "pass" : "fail";
  Object.assign(sections.geographicPlacePicker.calibration, { status: "approved", reference: calibration.reference, autocompleteP95LimitMs: calibration.autocompleteP95LimitMs, detailsP95LimitMs: calibration.detailsP95LimitMs, autocompleteOutcome, detailsOutcome, outcome: autocompleteOutcome === "pass" && detailsOutcome === "pass" ? "pass" : "fail" });
  return sections;
}

test("records the unauthenticated public-chat API baseline performance metrics", async ({ page, request }) => {
  await installPerformanceObservers(page);
  await page.goto("/", { waitUntil: "networkidle" });
  await createMeasuredInteraction(page, "public");
  const requestDurations: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const startedAt = performance.now();
    const response = await request.post("/api/chat");
    requestDurations.push(performance.now() - startedAt);
    expect(response.status()).toBe(401);
  }
  const metrics = await readBrowserMetrics(page);
  const artifact = { ...metrics, p95: percentile95(requestDurations), baseline: "public-chat-api-unauthenticated-401", baselineDescription: "Unauthenticated /api/chat guard before rate limiting, usage mutation, or provider work.", sampleCount: requestDurations.length, timestamp: new Date().toISOString(), commitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
  expect(metrics.interactionEntries).toBeGreaterThan(0);
  expect(metrics.inp).toBeGreaterThan(0);
  writePerformanceArtifact(publicBaselineArtifactPath, artifact);
});

test("records authenticated admin, selector, and Places performance evidence", async ({ context, page, request }) => {
  test.setTimeout(300_000);
  const fixture = await loadBrowserFixtureManifest();
  const adminCookie = fixture.sessions.super_admin;
  if (!adminCookie) throw new Error("Guarded fixture manifest omitted the assured Super Admin session.");
  await installSessionCookie(context, adminCookie);
  expect(fs.existsSync(publicBaselineArtifactPath)).toBe(true);
  const publicBaseline = readPerformanceArtifact(publicBaselineArtifactPath) as BrowserMetrics & { p95: number };
  await installPerformanceObservers(page);
  await page.goto("/admin", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "System overview" })).toBeVisible();
  await createMeasuredInteraction(page, "admin");
  const adminDurations: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const startedAt = performance.now();
    const response = await request.get("/admin", { headers: { cookie: adminCookie } });
    adminDurations.push(performance.now() - startedAt);
    expect(response.status()).toBe(200);
  }
  const browserMetrics = await readBrowserMetrics(page);
  const baseArtifact = buildAdminSliceArtifact(publicBaseline, { lcp: browserMetrics.lcp, inp: browserMetrics.inp, cls: browserMetrics.cls, routeJsGzip: adminOnlyScriptBytes(publicBaseline.scriptResources, browserMetrics.scriptResources), p95: percentile95(adminDurations) }, { commitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), timestamp: new Date().toISOString(), sampleCount: adminDurations.length });

  await installSessionCookie(context, fixture.variants.normal.cookie);
  const off = await collectSelectorProfile(page, fixture, "desktop", false);
  const desktop = await collectSelectorProfile(page, fixture, "desktop", true);
  const mobile = await collectSelectorProfile(page, fixture, "mobile", true);
  const placesRequests: string[] = [];
  page.on("request", (entry) => { if (entry.url().includes("/api/admin/geographic-places/")) placesRequests.push(entry.url()); });
  const throttled = await collectSelectorProfile(page, fixture, "throttled", true);
  const baselineP95Ms = percentile95(off.samplesMs);
  const placePicker = await collectPlacePicker(request, adminCookie, fixture);
  const calibration = approvedCalibration();
  const sections = applyCalibration(buildJurisdictionPerformanceSections({
    selectorProfiles: [
      { flagState: "off", profile: "desktop", ...off, baselineP95Ms },
      { flagState: "on", profile: "desktop", ...desktop, baselineP95Ms },
      { flagState: "on", profile: "mobile", ...mobile, baselineP95Ms },
      { flagState: "on", profile: "throttled", ...throttled, baselineP95Ms },
    ],
    placePicker,
    organizationalPlacesInvocationCount: placesRequests.length,
  }), calibration);
  const calibratedOutcome = [sections.jurisdictionSelector.calibration, sections.geographicPlacePicker.calibration]
    .every((entry) => entry.status === "approved" && entry.outcome === "pass")
    ? "pass"
    : calibration ? "fail" : "incomplete";
  writePerformanceArtifact(artifactPath, { ...baseArtifact, ...sections, calibratedOutcome, targetClass: process.env.ADMIN_E2E_TARGET_ENV, browserProfile: "chromium", deviceProfiles: ["desktop-1280x900", "mobile-390x844"], networkProfiles: ["unthrottled", "150ms-1600kbps-down-750kbps-up"] });
});
