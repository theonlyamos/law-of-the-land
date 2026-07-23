import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkBudgets,
  requireAdminSessionCookie,
} from "../../../scripts/check-admin-budgets.mjs";

function approvedArtifact() {
  const before = {
    lcp: 2300,
    inp: 170,
    cls: 0.04,
    routeJsGzip: 0,
    p95: 430,
  };
  const after = {
    lcp: 2400,
    inp: 180,
    cls: 0.05,
    routeJsGzip: 240_000,
    p95: 450,
  };
  const delta = {
    lcp: 100,
    inp: 10,
    cls: 0.01,
    routeJsGzip: 240_000,
    p95: 20,
  };
  return {
    ...after,
    baseline: "authenticated-admin-overview",
    sampleCount: 20,
    before,
    after,
    delta,
  };
}

describe("admin performance budgets", () => {
  it("accepts the approved limits", () => {
    expect(checkBudgets(approvedArtifact())).toEqual([]);
  });

  it("rejects an unauthenticated baseline and the wrong sample count", () => {
    const artifact = {
      ...approvedArtifact(),
      baseline: "public-search-api-unauthenticated-401",
      sampleCount: 19,
    };

    expect(checkBudgets(artifact)).toEqual(
      expect.arrayContaining([
        "baseline must be authenticated-admin-overview",
        "sampleCount must be exactly 20",
      ]),
    );
  });

  it("rejects non-finite before, after, and delta structures", () => {
    const artifact = approvedArtifact();
    artifact.before.lcp = Number.NaN;
    artifact.after.inp = Number.POSITIVE_INFINITY;
    artifact.delta.cls = Number.NaN;

    expect(checkBudgets(artifact)).toEqual(
      expect.arrayContaining([
        "before must contain finite lcp, inp, cls, routeJsGzip, and p95 metrics",
        "after must contain finite lcp, inp, cls, routeJsGzip, and p95 metrics",
        "delta must contain finite lcp, inp, cls, routeJsGzip, and p95 metrics",
      ]),
    );
  });

  it("requires an assured administrator session before budget execution", () => {
    expect(() => requireAdminSessionCookie({})).toThrow(
      "ADMIN_E2E_SESSION_COOKIE is required",
    );
  });

  it("exits nonzero with a clear inconclusive result when the session cookie is absent", () => {
    const { ADMIN_E2E_SESSION_COOKIE: _cookie, ...environment } = process.env;
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/check-admin-budgets.mjs"),
        "--require-session",
      ],
      { encoding: "utf8", env: environment },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "Authenticated admin performance is inconclusive",
    );
  });
});
