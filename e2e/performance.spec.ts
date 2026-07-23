import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { writePerformanceArtifact } from "../scripts/admin-performance-artifact.mjs";
import {
  adminOnlyScriptBytes,
  buildAdminSliceArtifact,
  percentile95,
} from "../scripts/admin-performance-collector.mjs";

type ScriptResource = { url: string; encodedBodySize: number };

type BrowserMetrics = {
  lcp: number;
  inp: number | null;
  cls: number;
  routeJsGzip: number;
  scriptResources: ScriptResource[];
  interactionEntries: number;
};

const artifactPath = path.resolve("artifacts/admin-performance.json");
const publicBaselineArtifactPath = path.resolve(
  "test-results/admin-performance-public-baseline.json",
);
const adminSessionCookie = process.env.ADMIN_E2E_SESSION_COOKIE;

test.afterAll(() => {
  fs.rmSync(publicBaselineArtifactPath, { force: true });
});

async function installPerformanceObservers(page: Page) {
  await page.addInitScript(() => {
    const metrics = {
      lcp: 0,
      inp: null as number | null,
      cls: 0,
      interactionEntries: 0,
    };
    Object.assign(window, { __adminPerformanceMetrics: metrics });

    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        metrics.lcp = Math.max(metrics.lcp, entry.startTime);
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });

    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries() as PerformanceEntryList &
        Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
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
    }).observe({
      type: "event",
      buffered: true,
      durationThreshold: 0,
    } as PerformanceObserverInit & { durationThreshold: number });
  });
}

async function readBrowserMetrics(page: Page): Promise<BrowserMetrics> {
  return await page.evaluate(() => {
    const observed = (
      window as unknown as Window & {
        __adminPerformanceMetrics: {
          lcp: number;
          inp: number | null;
          cls: number;
          interactionEntries: number;
        };
      }
    ).__adminPerformanceMetrics;
    const scriptResources = (
      performance.getEntriesByType("resource") as PerformanceResourceTiming[]
    )
      .filter(
        (entry) =>
          entry.initiatorType === "script" &&
          new URL(entry.name).origin === location.origin,
      )
      .map((entry) => ({
        url: new URL(entry.name).pathname,
        encodedBodySize: entry.encodedBodySize,
      }));
    const routeJsGzip = scriptResources.reduce(
      (total, entry) => total + entry.encodedBodySize,
      0,
    );

    return { ...observed, routeJsGzip, scriptResources };
  });
}

async function createMeasuredInteraction(page: Page, target: "public" | "admin") {
  if (target === "public") {
    const searchBox = page.getByRole("textbox").first();
    await expect(searchBox).toBeVisible();
    await searchBox.click();
    await page.keyboard.press("A");
  } else {
    const overviewLink = page.getByRole("link", { name: "Overview" });
    await expect(overviewLink).toBeVisible();
    await overviewLink.click();
  }

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as Window & {
              __adminPerformanceMetrics: { interactionEntries: number };
            }
          ).__adminPerformanceMetrics.interactionEntries,
      ),
    )
    .toBeGreaterThan(0);
}

test("records the unauthenticated public-search API baseline performance metrics", async ({ page, request }) => {
  await installPerformanceObservers(page);
  await page.goto("/", { waitUntil: "networkidle" });
  await createMeasuredInteraction(page, "public");

  const requestDurations: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const startedAt = performance.now();
    // The unauthenticated guard is deterministic and returns before provider work.
    const response = await request.post("/api/search", {
      data: { query: "tenant rights" },
    });
    requestDurations.push(performance.now() - startedAt);
    expect(response.status()).toBe(401);
  }

  const metrics = await readBrowserMetrics(page);
  const artifact = {
    ...metrics,
    p95: percentile95(requestDurations),
    baseline: "public-search-api-unauthenticated-401",
    baselineDescription:
      "Unauthenticated /api/search guard before rate limiting, usage mutation, or provider work.",
    sampleCount: requestDurations.length,
    timestamp: new Date().toISOString(),
    commitSha: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  };
  expect(metrics.interactionEntries).toBeGreaterThan(0);
  expect(metrics.inp).toBeGreaterThan(0);
  expect(
    [artifact.lcp, artifact.inp, artifact.cls, artifact.routeJsGzip, artifact.p95].every(
      Number.isFinite,
    ),
  ).toBeTruthy();

  writePerformanceArtifact(publicBaselineArtifactPath, artifact);
});

test("records the authenticated admin overview against the public baseline", async ({
  context,
  page,
  request,
}) => {
  test.skip(
    !adminSessionCookie,
    "Set ADMIN_E2E_SESSION_COOKIE to a locally seeded assured administrator session.",
  );
  const separator = adminSessionCookie!.indexOf("=");
  expect(separator).toBeGreaterThan(0);
  const cookieName = adminSessionCookie!.slice(0, separator);
  const cookieValue = adminSessionCookie!.slice(separator + 1).split(";", 1)[0];
  await context.addCookies([
    {
      name: cookieName,
      value: cookieValue,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  expect(fs.existsSync(publicBaselineArtifactPath)).toBe(true);
  const publicBaseline = JSON.parse(
    fs.readFileSync(publicBaselineArtifactPath, "utf8"),
  ) as {
    lcp: number;
    inp: number;
    cls: number;
    routeJsGzip: number;
    p95: number;
    scriptResources: ScriptResource[];
  };

  await installPerformanceObservers(page);
  await page.goto("/admin", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "System overview" }),
  ).toBeVisible();
  await createMeasuredInteraction(page, "admin");

  const cookieHeader = `${cookieName}=${cookieValue}`;
  const requestDurations: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const startedAt = performance.now();
    const response = await request.get("/admin", {
      headers: { cookie: cookieHeader },
    });
    requestDurations.push(performance.now() - startedAt);
    expect(response.status()).toBe(200);
  }

  const browserMetrics = await readBrowserMetrics(page);
  const after = {
    lcp: browserMetrics.lcp,
    inp: browserMetrics.inp,
    cls: browserMetrics.cls,
    routeJsGzip: adminOnlyScriptBytes(
      publicBaseline.scriptResources,
      browserMetrics.scriptResources,
    ),
    p95: percentile95(requestDurations),
  };
  expect(browserMetrics.interactionEntries).toBeGreaterThan(0);
  expect(after.inp).toBeGreaterThan(0);

  const artifact = buildAdminSliceArtifact(publicBaseline, after, {
    commitSha: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    timestamp: new Date().toISOString(),
    sampleCount: requestDurations.length,
  });
  writePerformanceArtifact(artifactPath, {
    ...artifact,
    scriptResources: browserMetrics.scriptResources,
    fixture:
      "Locally seeded Better Auth administrator supplied through ADMIN_E2E_SESSION_COOKIE.",
  });
});
