import fs from "node:fs";
import { pathToFileURL } from "node:url";

const METRIC_KEYS = ["lcp", "inp", "cls", "routeJsGzip", "p95"];

/**
 * @param {unknown} metrics
 * @returns {boolean}
 */
function hasFiniteMetrics(metrics) {
  return (
    typeof metrics === "object" &&
    metrics !== null &&
    METRIC_KEYS.every((key) => Number.isFinite(metrics[key]))
  );
}

/** @param {Record<string, unknown>} environment */
export function requireAdminSessionCookie(environment = process.env) {
  const cookie = environment.ADMIN_E2E_SESSION_COOKIE;
  if (typeof cookie !== "string" || cookie.trim().length === 0) {
    throw new Error(
      "Authenticated admin performance is inconclusive: ADMIN_E2E_SESSION_COOKIE is required.",
    );
  }
  return cookie;
}

/** @param {Record<string, unknown>} m */
export function checkBudgets(m) {
  const failures = [];
  if (m.baseline !== "authenticated-admin-overview") {
    failures.push("baseline must be authenticated-admin-overview");
  }
  if (m.sampleCount !== 20) {
    failures.push("sampleCount must be exactly 20");
  }
  for (const snapshot of ["before", "after", "delta"]) {
    if (!hasFiniteMetrics(m[snapshot])) {
      failures.push(
        `${snapshot} must contain finite lcp, inp, cls, routeJsGzip, and p95 metrics`,
      );
    }
  }

  if (hasFiniteMetrics(m.after)) {
    failures.push(
      m.after.lcp > 2500 && `LCP ${m.after.lcp}ms exceeds 2500ms`,
      m.after.inp > 200 && `INP ${m.after.inp}ms exceeds 200ms`,
      m.after.cls > 0.1 && `CLS ${m.after.cls} exceeds 0.1`,
      m.after.routeJsGzip > 250_000 &&
        `route JS ${m.after.routeJsGzip} exceeds 250000 bytes`,
      m.after.p95 > 500 && `p95 ${m.after.p95}ms exceeds 500ms`,
    );
  }
  return failures.filter((failure) => typeof failure === "string");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--require-session") {
    try {
      requireAdminSessionCookie();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  } else {
    try {
      const metrics = JSON.parse(
        fs.readFileSync(
          process.argv[2] ?? "artifacts/admin-performance.json",
          "utf8",
        ),
      );
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
