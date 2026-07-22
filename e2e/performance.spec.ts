import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

type BrowserMetrics = {
  lcp: number;
  inp: number;
  cls: number;
  routeJsGzip: number;
};

const artifactPath = path.resolve("artifacts/admin-performance.json");

function percentile95(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

test("records public search-route performance metrics", async ({ page, request }) => {
  await page.addInitScript(() => {
    const metrics = { lcp: 0, inp: 0, cls: 0 };
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
        metrics.inp = Math.max(metrics.inp, entry.duration);
      }
    }).observe({ type: "event", buffered: true, durationThreshold: 0 });
  });

  await page.goto("/", { waitUntil: "networkidle" });
  const searchBox = page.getByRole("textbox").first();
  await expect(searchBox).toBeVisible();
  await searchBox.fill("What are my tenant rights?");
  await page.waitForTimeout(100);

  const requestDurations: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const startedAt = performance.now();
    const response = await request.get("/");
    requestDurations.push(performance.now() - startedAt);
    expect(response.ok()).toBeTruthy();
  }

  const metrics = await page.evaluate(() => {
    const observed = (window as Window & { __adminPerformanceMetrics: Omit<BrowserMetrics, "routeJsGzip"> }).__adminPerformanceMetrics;
    const routeJsGzip = performance
      .getEntriesByType("resource")
      .filter((entry) => entry.initiatorType === "script" && new URL(entry.name).origin === location.origin)
      .reduce((total, entry) => total + entry.encodedBodySize, 0);

    return { ...observed, routeJsGzip };
  });

  const p95 = percentile95(requestDurations);
  const allMetrics = { ...metrics, p95 };
  expect(Object.values(allMetrics).every(Number.isFinite)).toBeTruthy();

  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(
    artifactPath,
    `${JSON.stringify({ ...allMetrics, timestamp: new Date().toISOString(), commitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() }, null, 2)}\n`,
  );
});
