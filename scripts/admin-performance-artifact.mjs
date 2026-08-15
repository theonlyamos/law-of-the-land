import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const METRIC_KEYS = ["lcp", "inp", "cls", "routeJsGzip", "p95"];
const FORBIDDEN_KEY = /(?:cookie|token|secret|api.?key|claim|question|provider.?body|user.?id|place.?id|address)/i;

export function assertRedactionSafe(value, depth = 0) {
  if (depth > 12) throw new TypeError("Admin performance artifact must remain bounded and redaction-safe.");
  if (typeof value === "string") {
    if (value.length > 1_000 || /https?:\/\//i.test(value) || /better-auth|\bbearer\b/i.test(value)) {
      throw new TypeError("Admin performance artifact must remain bounded and redaction-safe.");
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length > 500) throw new TypeError("Admin performance artifact must remain bounded and redaction-safe.");
    for (const item of value) assertRedactionSafe(item, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) throw new TypeError("Admin performance artifact must remain bounded and redaction-safe.");
    if (key === "url" && typeof item === "string" && !item.startsWith("/")) {
      throw new TypeError("Admin performance artifact must remain bounded and redaction-safe.");
    }
    assertRedactionSafe(item, depth + 1);
  }
}

export function assertFiniteMetrics(metrics) {
  if (!METRIC_KEYS.every((key) => Number.isFinite(metrics[key]))) {
    throw new TypeError("Admin performance metrics must contain finite numbers for lcp, inp, cls, routeJsGzip, and p95.");
  }
}

export function writePerformanceArtifact(artifactPath, artifact) {
  assertFiniteMetrics(artifact);
  assertRedactionSafe(artifact);
  const serialized = JSON.stringify(artifact, null, 2);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 2_000_000) {
    throw new TypeError("Admin performance artifact must be serializable.");
  }

  const directory = path.dirname(artifactPath);
  const temporaryPath = path.join(directory, `.${path.basename(artifactPath)}.${process.pid}.${randomUUID()}.tmp`);
  fs.mkdirSync(directory, { recursive: true });

  try {
    fs.writeFileSync(temporaryPath, `${serialized}\n`);
    fs.renameSync(temporaryPath, artifactPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}
