import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePerformanceArtifact } from "../../../scripts/admin-performance-artifact.mjs";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("admin performance artifact writer", () => {
  it("atomically writes a serialized metrics artifact without leaving sibling temporary files", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "admin-performance-artifact-"));
    tempDirectories.push(directory);
    const artifactPath = path.join(directory, "admin-performance.json");
    const metrics = { lcp: 2000, inp: 120, cls: 0.04, routeJsGzip: 100_000, p95: 300, baseline: "public-search-api-unauthenticated" };

    writePerformanceArtifact(artifactPath, metrics);

    expect(JSON.parse(fs.readFileSync(artifactPath, "utf8"))).toEqual(metrics);
    expect(fs.readdirSync(directory)).toEqual(["admin-performance.json"]);
  });

  it("rejects invalid metrics before creating an artifact", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "admin-performance-artifact-"));
    tempDirectories.push(directory);
    const artifactPath = path.join(directory, "admin-performance.json");

    expect(() => writePerformanceArtifact(artifactPath, { lcp: Number.NaN })).toThrow("finite numbers");
    expect(fs.existsSync(artifactPath)).toBe(false);
  });
});
