import fs from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * @typedef {Object} AdminPerformanceMetrics
 * @property {number} lcp
 * @property {number} inp
 * @property {number} cls
 * @property {number} routeJsGzip
 * @property {number} p95
 */

/** @param {AdminPerformanceMetrics} m */
export function checkBudgets(m) {
  return [
    m.lcp > 2500 && `LCP ${m.lcp}ms exceeds 2500ms`,
    m.inp > 200 && `INP ${m.inp}ms exceeds 200ms`,
    m.cls > 0.1 && `CLS ${m.cls} exceeds 0.1`,
    m.routeJsGzip > 250_000 && `route JS ${m.routeJsGzip} exceeds 250000 bytes`,
    m.p95 > 500 && `p95 ${m.p95}ms exceeds 500ms`,
  ].filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const metrics = JSON.parse(fs.readFileSync(process.argv[2] ?? "artifacts/admin-performance.json", "utf8"));
  const failures = checkBudgets(metrics);
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  }
}
