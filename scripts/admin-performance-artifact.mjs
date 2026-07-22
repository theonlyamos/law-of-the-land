import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const METRIC_KEYS = ["lcp", "inp", "cls", "routeJsGzip", "p95"];

export function assertFiniteMetrics(metrics) {
  if (!METRIC_KEYS.every((key) => Number.isFinite(metrics[key]))) {
    throw new TypeError("Admin performance metrics must contain finite numbers for lcp, inp, cls, routeJsGzip, and p95.");
  }
}

export function writePerformanceArtifact(artifactPath, artifact) {
  assertFiniteMetrics(artifact);
  const serialized = JSON.stringify(artifact, null, 2);
  if (serialized === undefined) {
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
