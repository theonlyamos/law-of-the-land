import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { writePerformanceArtifact } from "../scripts/admin-performance-artifact.mjs";

type BrowserMetrics = {
  lcp: number;
  inp: number | null;
  cls: number;
  routeJsGzip: number;
};

const artifactPath = path.resolve("artifacts/admin-performance.json");

function percentile95(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

test("records the unauthenticated public-search API baseline performance metrics", async ({ page, request }) => {
  await page.addInitScript(() => {
    const metrics = { lcp: 0, inp: null as number | null, cls: 0, interactionEntries: 0 };
    Object.assign(window, { __adminPerformanceMetrics: metrics });

    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        metrics.lcp = Math.max(metrics.lcp, entry.startTime);
      }
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
    }).observe({ type: "event", buffered: true, durationThreshold: 0 });
  });

  await page.goto("/", { waitUntil: "networkidle" });
  const searchBox = page.getByRole("textbox").first();
  await expect(searchBox).toBeVisible();
  await searchBox.click();
  await page.keyboard.press("A");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __adminPerformanceMetrics: { interactionEntries: number } })
            .__adminPerformanceMetrics.interactionEntries,
      ),
    )
    .toBeGreaterThan(0);

  const requestDurations: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const startedAt = performance.now();
    // The unauthenticated guard is the deterministic public-search API baseline:
    // it returns before rate limiting, usage mutation, and the paid GroundX request.
    const response = await request.post("/api/search", { data: { query: "tenant rights" } });
    requestDurations.push(performance.now() - startedAt);
    expect(response.status()).toBe(401);
  }

  const metrics = await page.evaluate(() => {
    const observed = (window as Window & { __adminPerformanceMetrics: Omit<BrowserMetrics, "routeJsGzip"> & { interactionEntries: number } }).__adminPerformanceMetrics;
    const routeJsGzip = performance
      .getEntriesByType("resource")
      .filter((entry) => entry.initiatorType === "script" && new URL(entry.name).origin === location.origin)
      .reduce((total, entry) => total + entry.encodedBodySize, 0);

    return { ...observed, routeJsGzip };
  });

  const p95 = percentile95(requestDurations);
  const allMetrics = { ...metrics, p95 };
  expect(metrics.interactionEntries).toBeGreaterThan(0);
  expect(metrics.inp).toBeGreaterThan(0);
  expect(Object.values(allMetrics).every(Number.isFinite)).toBeTruthy();

  writePerformanceArtifact(artifactPath, {
    ...allMetrics,
    baseline: "public-search-api-unauthenticated-401",
    baselineDescription: "Unauthenticated /api/search guard only; Task 6 extends this collector with authenticated admin requests.",
    sampleCount: requestDurations.length,
    timestamp: new Date().toISOString(),
    commitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  });
});
